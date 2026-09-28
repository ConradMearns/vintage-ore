using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.API.Server;
using Vintagestory.ServerMods;

namespace OreSurvey;

/// <summary>One deposit placement attempt, i.e. one (variant, center) roll in GenDeposits.</summary>
public class DepositRecord
{
    public string Code;
    public string Generator;
    public string ParentCode;
    public int X, Y, Z;
    public int RadiusX, RadiusZ, Thickness;
    /// <summary>Number of generated chunks this deposit's disc overlapped.</summary>
    public int Calls;
}

/// <summary>
/// Hooks every deposit generator's GenDeposit. The game calls GenDeposit for the same deposit once per
/// chunk it may overlap (GenPartial re-derives neighbour deposits), so records are de-duplicated by
/// (code, center). Radius etc. are read in the postfix; they are rolled from a per-deposit seeded RNG,
/// so every call for the same deposit yields the same values.
/// </summary>
public static class DepositHooks
{
    public static readonly ConcurrentDictionary<(string, int, int, int), DepositRecord> Deposits = new();

    static readonly FieldInfo fVariant = AccessTools.Field(typeof(DepositGeneratorBase), "variant");
    static readonly FieldInfo fRadiusX = AccessTools.Field(typeof(DiscDepositGenerator), "radiusX");
    static readonly FieldInfo fRadiusZ = AccessTools.Field(typeof(DiscDepositGenerator), "radiusZ");
    static readonly FieldInfo fThickness = AccessTools.Field(typeof(DiscDepositGenerator), "depoitThickness");
    static readonly FieldInfo fParent = AccessTools.Field(typeof(DepositVariant), "parentDeposit");

    [ThreadStatic] static BlockPos entryPos;

    public static void Install(Harmony harmony, ILogger logger)
    {
        var baseType = typeof(DepositGeneratorBase);
        var types = AppDomain.CurrentDomain.GetAssemblies()
            .SelectMany(a => { try { return a.GetTypes(); } catch (ReflectionTypeLoadException e) { return e.Types.Where(t => t != null); } })
            .Where(t => baseType.IsAssignableFrom(t));

        var prefix = new HarmonyMethod(typeof(DepositHooks), nameof(Prefix));
        var postfix = new HarmonyMethod(typeof(DepositHooks), nameof(Postfix));
        foreach (var t in types)
        {
            var m = t.GetMethod("GenDeposit", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly);
            if (m == null || m.IsAbstract) continue;
            harmony.Patch(m, prefix, postfix);
            logger.Notification("[oresurvey] hooked {0}.GenDeposit", t.FullName);
        }
    }

    // depoCenterPos is mutated inside (Y is set), so capture the XZ as passed in.
    static void Prefix(IServerChunk[] __1, BlockPos __4)
    {
        // The propick's rock column sampler runs its own GenDeposits over DummyChunks with an unseeded RNG;
        // those placements never reach the world.
        entryPos = IsDummy(__1) ? null : __4.Copy();
    }

    static bool IsDummy(IServerChunk[] chunks) => chunks.Length > 0 && chunks[0]?.GetType().Name == "DummyChunk";

    static void Postfix(DepositGeneratorBase __instance, IServerChunk[] __1, int __2, int __3, BlockPos __4)
    {
        if (entryPos == null) return;
        var variant = (DepositVariant)fVariant.GetValue(__instance);
        if (variant == null) return;
        int rx = 0, rz = 0;
        if (__instance is DiscDepositGenerator && __instance is not ChildDepositGenerator)
        {
            // GenDeposits rolls every neighbour chunk's deposits for each generated chunk; only count the
            // ones whose disc reaches into this chunk. This also filters rolls that were shifted by an
            // unloaded neighbour map region (GetOreMapFactor returns 0), which never touch the chunk.
            rx = (int)fRadiusX.GetValue(__instance);
            rz = (int)fRadiusZ.GetValue(__instance);
            int bx = __2 * 32, bz = __3 * 32;
            if (entryPos.X + rx < bx || entryPos.Z + rz < bz || entryPos.X - rx >= bx + 32 || entryPos.Z - rz >= bz + 32) return;
        }
        var parent = (DepositVariant)fParent.GetValue(variant);
        var key = (variant.Code, entryPos.X, entryPos.Z, parent != null ? entryPos.Y : 0);
        var rec = Deposits.GetOrAdd(key, _ =>
        {
            var r = new DepositRecord
            {
                Code = variant.Code,
                Generator = __instance.GetType().Name,
                ParentCode = parent?.Code,
                X = entryPos.X, Z = entryPos.Z,
                Y = __4.Y,
            };
            if (__instance is DiscDepositGenerator)
            {
                r.RadiusX = rx;
                r.RadiusZ = rz;
                r.Thickness = (int)fThickness.GetValue(__instance);
            }
            return r;
        });
        lock (rec)
        {
            rec.Calls++;
            // Y is only resolved when the deposit actually touches the chunk being generated.
            if (rec.Y < 0 && __4.Y >= 0) rec.Y = __4.Y;
        }
    }
}
