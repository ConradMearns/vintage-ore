using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.API.Server;
using Vintagestory.GameContent;

namespace OreSurvey;

/// <summary>
/// Generates every chunk column in the survey area and dumps, per column:
///  - ore blocks (same predicate as the propick node search: material Ore with a "type" variant)
///  - the worldgen terrain heightmap (blob per column)
///  - cave air runs below the surface; everything else below the surface is solid, so mining cost stays exact
///  - propick density readings on a grid, computed by the game's own ItemProspectingPick.GenProbeResults
/// Deposit placements are collected by <see cref="DepositHooks"/> and written at the end.
/// </summary>
public class SurveyRunner
{
    const int CS = 32;

    readonly ICoreServerAPI sapi;
    readonly OreSurveyConfig cfg;
    readonly string outDir;
    readonly bool shutdownWhenDone;

    int cx0, cz0, ncx, ncz, mapSizeY;
    readonly Queue<(int cx, int cz)> pending = new();
    int inFlight, processed, total;
    public bool Done { get; private set; }
    readonly Stopwatch clock = new();
    long listenerId;

    SqliteConnection db;

    // Per block id lookups
    bool[] solidById;
    int[] oreIdByBlockId; // -1 if not ore, else index into ore block table (== block id)

    ItemProspectingPick propick;
    MethodInfo genProbeResults;

    public SurveyRunner(ICoreServerAPI sapi, OreSurveyConfig cfg, string outDir, bool shutdownWhenDone)
    {
        this.sapi = sapi;
        this.cfg = cfg;
        this.outDir = outDir;
        this.shutdownWhenDone = shutdownWhenDone;
    }

    public string StatusLine() =>
        $"{processed}/{total} columns, {inFlight} in flight, {DepositHooks.Deposits.Count} deposits, {clock.Elapsed:hh\\:mm\\:ss}";

    public void Start()
    {
        // The propick fills ppws.depositsByCode in its own RunGame callback; until then every reading is empty.
        propick = sapi.World.Items.OfType<ItemProspectingPick>().FirstOrDefault()
            ?? throw new InvalidOperationException("No ItemProspectingPick loaded");
        var ppws = typeof(ItemProspectingPick).GetField("ppws", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(propick) as ProPickWorkSpace;
        if (ppws == null || ppws.depositsByCode.Count == 0)
        {
            sapi.Event.RegisterCallback(_ => Start(), 500);
            return;
        }

        var wm = sapi.WorldManager;
        mapSizeY = wm.MapSizeY;
        int nChunks = (cfg.Size + CS - 1) / CS;
        int x0 = cfg.X0 ?? wm.MapSizeX / 2 - nChunks * CS / 2;
        int z0 = cfg.Z0 ?? wm.MapSizeZ / 2 - nChunks * CS / 2;
        cx0 = x0 / CS; cz0 = z0 / CS; ncx = ncz = nChunks;
        total = ncx * ncz;

        Directory.CreateDirectory(outDir);
        BuildBlockTables();
        genProbeResults = typeof(ItemProspectingPick).GetMethod("GenProbeResults", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);

        OpenOutputs();
        WriteMeta();

        for (int dz = 0; dz < ncz; dz++)
            for (int dx = 0; dx < ncx; dx++)
                pending.Enqueue((cx0 + dx, cz0 + dz));

        sapi.Logger.Notification("[oresurvey] surveying chunks x {0}..{1}, z {2}..{3} ({4} columns) -> {5}",
            cx0, cx0 + ncx - 1, cz0, cz0 + ncz - 1, total, outDir);
        clock.Start();
        listenerId = sapi.Event.RegisterGameTickListener(_ => sapi.Logger.Notification("[oresurvey] " + StatusLine()), 15000);
        Pump();
    }

    void BuildBlockTables()
    {
        var blocks = sapi.World.Blocks;
        solidById = new bool[blocks.Count];
        oreIdByBlockId = new int[blocks.Count];
        foreach (var b in blocks)
        {
            if (b == null) continue;
            int id = b.BlockId;
            if (id >= solidById.Length) continue;
            oreIdByBlockId[id] = -1;
            switch (b.BlockMaterial)
            {
                case EnumBlockMaterial.Soil:
                case EnumBlockMaterial.Gravel:
                case EnumBlockMaterial.Sand:
                case EnumBlockMaterial.Stone:
                case EnumBlockMaterial.Ore:
                case EnumBlockMaterial.Ice:
                case EnumBlockMaterial.Mantle:
                case EnumBlockMaterial.Brick:
                case EnumBlockMaterial.Wood:
                case EnumBlockMaterial.Ceramic:
                case EnumBlockMaterial.Metal:
                    solidById[id] = id != 0;
                    break;
            }
            if (b.BlockMaterial == EnumBlockMaterial.Ore && b.Variant != null && b.Variant.ContainsKey("type"))
                oreIdByBlockId[id] = id;
        }
    }

    void OpenOutputs()
    {
        string dbPath = Path.Combine(outDir, "survey.sqlite");
        if (File.Exists(dbPath)) File.Delete(dbPath);
        db = new SqliteConnection("Data Source=" + dbPath);
        db.Open();
        Exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;");
        Exec(@"CREATE TABLE blocks(id INTEGER PRIMARY KEY, code TEXT, ore TEXT, grade TEXT, rock TEXT);
               CREATE TABLE ore_blocks(x INTEGER, y INTEGER, z INTEGER, block_id INTEGER);
               CREATE TABLE readings(x INTEGER, z INTEGER, y INTEGER, ore TEXT, total_factor REAL, ppt REAL);
               CREATE TABLE deposits(id INTEGER PRIMARY KEY, code TEXT, generator TEXT, parent_code TEXT,
                                     x INTEGER, y INTEGER, z INTEGER, radius_x INTEGER, radius_z INTEGER, thickness INTEGER, calls INTEGER);
               CREATE TABLE columns(cx INTEGER, cz INTEGER, ms INTEGER, heights BLOB);
               CREATE TABLE air_runs(x INTEGER, z INTEGER, y0 INTEGER, y1 INTEGER);");

        using (var tx = db.BeginTransaction())
        using (var cmd = Cmd("INSERT INTO blocks VALUES($id,$code,$ore,$grade,$rock)", tx, "$id", "$code", "$ore", "$grade", "$rock"))
        {
            foreach (var b in sapi.World.Blocks)
            {
                if (b == null || b.BlockId >= oreIdByBlockId.Length || oreIdByBlockId[b.BlockId] < 0) continue;
                cmd.Parameters["$id"].Value = b.BlockId;
                cmd.Parameters["$code"].Value = b.Code.ToShortString();
                cmd.Parameters["$ore"].Value = b.Variant["type"];
                cmd.Parameters["$grade"].Value = b.Variant.TryGetValue("grade", out var g) ? g : DBNull.Value;
                cmd.Parameters["$rock"].Value = b.Variant.TryGetValue("rock", out var r) ? r : DBNull.Value;
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    void WriteMeta()
    {
        var worldConfig = new Dictionary<string, string>();
        foreach (var key in new[] { "globalDepositSpawnRate", "propickNodeSearchRadius", "surfaceCopperDeposits", "surfaceTinDeposits", "worldClimate", "landformScale", "geologicActivity" })
            worldConfig[key] = sapi.World.Config.GetAsString(key);
        var meta = new
        {
            gameVersion = Vintagestory.API.Config.GameVersion.ShortGameVersion,
            seed = sapi.World.Seed,
            playstyle = sapi.WorldManager.SaveGame.PlayStyle,
            worldConfig,
            mapSizeX = sapi.WorldManager.MapSizeX,
            mapSizeY,
            mapSizeZ = sapi.WorldManager.MapSizeZ,
            regionSize = sapi.WorldManager.RegionSize,
            chunkSize = CS,
            cx0, cz0, ncx, ncz,
            readingSpacing = cfg.ReadingSpacing,
            heightsLayout = "columns.heights: uint16 little-endian, index lz*32+lx (WorldGenTerrainHeightMap)",
            airRuns = "air_runs: inclusive y0..y1 of non-solid blocks strictly below terrain height (caves); everything else below surface is solid",
        };
        File.WriteAllText(Path.Combine(outDir, "meta.json"), JsonConvert.SerializeObject(meta, Formatting.Indented));
    }

    void Pump()
    {
        while (inFlight < cfg.MaxInFlight && pending.Count > 0)
        {
            var (cx, cz) = pending.Dequeue();
            inFlight++;
            sapi.WorldManager.LoadChunkColumnPriority(cx, cz, new ChunkLoadOptions
            {
                KeepLoaded = false,
                OnLoaded = () => OnColumnLoaded(cx, cz),
            });
        }
        if (inFlight == 0 && pending.Count == 0 && !Done) Finish();
    }

    void OnColumnLoaded(int cx, int cz)
    {
        var sw = Stopwatch.StartNew();
        byte[] heights = null;
        try
        {
            heights = ProcessColumn(cx, cz);
        }
        catch (Exception e)
        {
            sapi.Logger.Error("[oresurvey] column {0},{1} failed: {2}", cx, cz, e);
        }
        using (var cmd = Cmd("INSERT INTO columns VALUES($a,$b,$c,$h)", null, "$a", "$b", "$c", "$h"))
        {
            cmd.Parameters["$a"].Value = cx; cmd.Parameters["$b"].Value = cz; cmd.Parameters["$c"].Value = sw.ElapsedMilliseconds;
            cmd.Parameters["$h"].Value = (object)heights ?? DBNull.Value;
            cmd.ExecuteNonQuery();
        }
        processed++;
        inFlight--;
        Pump();
    }

    byte[] ProcessColumn(int cx, int cz)
    {
        var wm = sapi.WorldManager;
        var mapChunk = wm.GetMapChunk(cx, cz);
        ushort[] terrainHeight = mapChunk.WorldGenTerrainHeightMap;
        // solid[(y*32+lz)*32+lx]; only kept in memory to extract cave air runs
        var solid = new bool[mapSizeY * CS * CS];

        using var tx = db.BeginTransaction();
        using (var ins = Cmd("INSERT INTO ore_blocks VALUES($x,$y,$z,$b)", tx, "$x", "$y", "$z", "$b"))
        {
            for (int cy = 0; cy < mapSizeY / CS; cy++)
            {
                var chunk = wm.GetChunk(cx, cy, cz);
                if (chunk == null) throw new InvalidOperationException($"chunk {cx},{cy},{cz} not loaded");
                chunk.Unpack();
                var data = chunk.Data;
                for (int i = 0; i < CS * CS * CS; i++)
                {
                    int id = data.GetBlockIdUnsafe(i);
                    if (id == 0 || id >= solidById.Length) continue;
                    if (solidById[id]) solid[cy * CS * CS * CS + i] = true;
                    if (oreIdByBlockId[id] >= 0)
                    {
                        int lx = i % CS, lz = (i / CS) % CS, ly = i / (CS * CS);
                        ins.Parameters["$x"].Value = cx * CS + lx;
                        ins.Parameters["$y"].Value = cy * CS + ly;
                        ins.Parameters["$z"].Value = cz * CS + lz;
                        ins.Parameters["$b"].Value = id;
                        ins.ExecuteNonQuery();
                    }
                }
            }
        }

        using (var ins = Cmd("INSERT INTO air_runs VALUES($x,$z,$a,$b)", tx, "$x", "$z", "$a", "$b"))
        {
            for (int lz = 0; lz < CS; lz++)
            {
                for (int lx = 0; lx < CS; lx++)
                {
                    int top = Math.Min(terrainHeight[lz * CS + lx], mapSizeY);
                    int runStart = -1;
                    for (int y = 0; y <= top; y++)
                    {
                        bool air = y < top && !solid[(y * CS + lz) * CS + lx];
                        if (air && runStart < 0) runStart = y;
                        else if (!air && runStart >= 0)
                        {
                            ins.Parameters["$x"].Value = cx * CS + lx;
                            ins.Parameters["$z"].Value = cz * CS + lz;
                            ins.Parameters["$a"].Value = runStart;
                            ins.Parameters["$b"].Value = y - 1;
                            ins.ExecuteNonQuery();
                            runStart = -1;
                        }
                    }
                }
            }
        }

        using (var ins = Cmd("INSERT INTO readings VALUES($x,$z,$y,$o,$f,$p)", tx, "$x", "$z", "$y", "$o", "$f", "$p"))
        {
            int sp = cfg.ReadingSpacing;
            for (int lz = 0; lz < CS; lz += sp)
            {
                for (int lx = 0; lx < CS; lx += sp)
                {
                    var pos = new BlockPos(cx * CS + lx, 0, cz * CS + lz);
                    var reading = (PropickReading)genProbeResults.Invoke(propick, new object[] { sapi.World, pos });
                    if (reading == null) continue;
                    foreach (var kv in reading.OreReadings)
                    {
                        ins.Parameters["$x"].Value = pos.X;
                        ins.Parameters["$z"].Value = pos.Z;
                        ins.Parameters["$y"].Value = (int)reading.Position.Y;
                        ins.Parameters["$o"].Value = kv.Key;
                        ins.Parameters["$f"].Value = kv.Value.TotalFactor;
                        ins.Parameters["$p"].Value = kv.Value.PartsPerThousand;
                        ins.ExecuteNonQuery();
                    }
                }
            }
        }
        tx.Commit();

        var heights = new byte[CS * CS * 2];
        Buffer.BlockCopy(terrainHeight, 0, heights, 0, heights.Length);
        return heights;
    }

    void Finish()
    {
        Done = true;
        sapi.Event.UnregisterGameTickListener(listenerId);
        using (var tx = db.BeginTransaction())
        using (var cmd = Cmd("INSERT INTO deposits(code,generator,parent_code,x,y,z,radius_x,radius_z,thickness,calls) VALUES($c,$g,$p,$x,$y,$z,$rx,$rz,$t,$n)",
                   tx, "$c", "$g", "$p", "$x", "$y", "$z", "$rx", "$rz", "$t", "$n"))
        {
            foreach (var d in DepositHooks.Deposits.Values.OrderBy(d => d.Code).ThenBy(d => d.X).ThenBy(d => d.Z))
            {
                cmd.Parameters["$c"].Value = d.Code;
                cmd.Parameters["$g"].Value = d.Generator;
                cmd.Parameters["$p"].Value = (object)d.ParentCode ?? DBNull.Value;
                cmd.Parameters["$x"].Value = d.X; cmd.Parameters["$y"].Value = d.Y; cmd.Parameters["$z"].Value = d.Z;
                cmd.Parameters["$rx"].Value = d.RadiusX; cmd.Parameters["$rz"].Value = d.RadiusZ;
                cmd.Parameters["$t"].Value = d.Thickness; cmd.Parameters["$n"].Value = d.Calls;
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }
        Exec("CREATE INDEX ore_blocks_xz ON ore_blocks(x, z); CREATE INDEX readings_xz ON readings(x, z); CREATE INDEX air_runs_xz ON air_runs(x, z);");
        db.Close();
        File.WriteAllText(Path.Combine(outDir, "DONE"), StatusLine());
        sapi.Logger.Notification("[oresurvey] finished: " + StatusLine());
        if (shutdownWhenDone) sapi.Server.ShutDown();
    }

    void Exec(string sql)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    SqliteCommand Cmd(string sql, SqliteTransaction tx, params string[] names)
    {
        var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        cmd.Transaction = tx;
        foreach (var n in names) cmd.Parameters.Add(new SqliteParameter(n, null));
        return cmd;
    }
}
