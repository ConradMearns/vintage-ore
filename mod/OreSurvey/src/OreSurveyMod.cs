using System;
using System.IO;
using HarmonyLib;
using Vintagestory.API.Common;
using Vintagestory.API.Server;

namespace OreSurvey;

public class OreSurveyConfig
{
    /// <summary>Start the survey automatically once the server is running.</summary>
    public bool AutoRun = false;
    /// <summary>Shut the server down when an auto-run survey finishes.</summary>
    public bool ShutdownWhenDone = false;
    /// <summary>Survey area side length in blocks (rounded up to whole chunks), centered on the map center unless X0/Z0 are set.</summary>
    public int Size = 2048;
    public int? X0 = null;
    public int? Z0 = null;
    /// <summary>Propick density reading grid spacing, in blocks.</summary>
    public int ReadingSpacing = 4;
    /// <summary>Max chunk columns requested but not yet processed.</summary>
    public int MaxInFlight = 48;
    /// <summary>Output directory; relative paths resolve against the server data path.</summary>
    public string OutDir = "survey";
}

public class OreSurveyMod : ModSystem
{
    public const string HarmonyId = "oresurvey";

    ICoreServerAPI sapi;
    Harmony harmony;
    SurveyRunner runner;
    public OreSurveyConfig Config;

    public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Server;

    // Patch before GenDeposits initialises so no deposit is missed.
    public override double ExecuteOrder() => 0;

    public override void StartServerSide(ICoreServerAPI api)
    {
        sapi = api;
        Config = api.LoadModConfig<OreSurveyConfig>("oresurvey.json");
        if (Config == null)
        {
            Config = new OreSurveyConfig();
            api.StoreModConfig(Config, "oresurvey.json");
        }

        harmony = new Harmony(HarmonyId);
        DepositHooks.Install(harmony, api.Logger);

        api.ChatCommands.Create("oresurvey")
            .WithDescription("Ore research survey")
            .RequiresPrivilege(Privilege.controlserver)
            .BeginSubCommand("run")
                .WithDescription("Run the survey over the configured area")
                .HandleWith(_ => { Start(false); return TextCommandResult.Success("Survey started"); })
            .EndSubCommand()
            .BeginSubCommand("status")
                .HandleWith(_ => TextCommandResult.Success(runner?.StatusLine() ?? "idle"))
            .EndSubCommand();

        api.Event.ServerRunPhase(EnumServerRunPhase.RunGame, () =>
        {
            if (Config.AutoRun) Start(Config.ShutdownWhenDone);
        });
    }

    void Start(bool shutdownWhenDone)
    {
        if (runner != null && !runner.Done)
        {
            sapi.Logger.Warning("[oresurvey] survey already running");
            return;
        }
        string outDir = Config.OutDir;
        if (!Path.IsPathRooted(outDir)) outDir = Path.Combine(sapi.GetOrCreateDataPath(".."), outDir);
        runner = new SurveyRunner(sapi, Config, Path.GetFullPath(outDir), shutdownWhenDone);
        runner.Start();
    }

    public override void Dispose()
    {
        harmony?.UnpatchAll(HarmonyId);
    }
}
