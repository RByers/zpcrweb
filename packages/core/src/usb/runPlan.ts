/**
 * Everything about starting a run that can be decided *before* touching the wire.
 *
 * Starting a run is two separable things (`usb.md` §7): the protocol is **typed at the instrument**
 * one directive per command line and started with `RemoteRun` (§7.2–§7.3), and the run's files are
 * **deposited** into the run folder afterwards (§7.4). Both are derived entirely from a run
 * definition and a plate — no device needed — so they are computed here, as data, and
 * {@link CfxDevice.startRun} does nothing but send what this produced.
 *
 * That split is what makes a run reviewable. The Instrument view can show the exact command lines
 * and the exact file bytes that would leave the machine, and the checks below can refuse or warn
 * *before* a block is heated, because the plan is a value rather than a side effect.
 *
 * **The deposit is not what runs.** `usb.md` §7.4 measures the upload starting thirteen seconds
 * *after* the run is already cycling, which settles what §5.1 could only argue from the sample
 * archives: the instrument executes the ASCII step list and never opens the files. Their job is to
 * make the finished run folder a self-contained experiment — the directive list can express a
 * thermal protocol but not a plate map, well contents or dye assignments, so without them the
 * `.zpcr` that folder becomes has no idea what was in the wells.
 *
 * **So the files are this project's own plaintext formats**, `.prcl.txt` (`prcl.md` §3.1) and
 * `.plt.csv` (`plateCsv.ts`), rather than the encrypted `.prcl`/`.pltd` pair CFX Manager deposits.
 * The mechanism is identical — §5's upload cycle treats a file as opaque bytes — and since nothing
 * on the instrument reads either one, the only question is which is more useful in the archive
 * afterwards. An encrypted `.pltd` would need a password this repository doesn't ship; a
 * `.plt.csv` is picked straight up by `zpcr.plates()`, so the run opens with its plate intact.
 *
 * **And each keeps its own name.** A protocol and a plate are things reused across many runs,
 * with names of their own; an experiment name belongs to one run. So the deposited copies are
 * called after the protocol and the plate they are (`PlanRunOptions.protocolName`/`plateName`),
 * and the run's name travels by the channel §7.3 gives it — `RemoteRun`, `STATUS?` and the
 * `.alf` report — rather than being stamped onto files it doesn't own.
 *
 * **A third file carries the name itself.** `RemoteRun`'s name operand reaches the instrument's
 * own filenames and nothing else — no Bio-Rad format has a field for what a run is *called*
 * (`experiment.ts`) — so a named run also deposits a `zpcrweb.json` saying so, and the archive
 * assembled from the folder states its own name from then on.
 *
 * **A fourth restores a marker CFX Manager's own runs get for free.** `usb.md` §7.5 measures the
 * instrument writing `ProtocolName.txt` into the run folder itself as a run finishes. Observed in
 * practice: a run started here through `RemoteRun` never gets that write, even though a
 * touchscreen- or CFX Manager-started one does — so a run this app starts would otherwise open
 * with no way to say what protocol it ran, unlike one pulled from either of those. A named
 * protocol also deposits its own `ProtocolName.txt`, which closes that gap the same way the third
 * file closes the missing-run-name one.
 */
import type { PlateDefinition } from "../pltd.js";
import {
  formatZpcrwebSettings,
  ZPCRWEB_SETTINGS_NAME,
  ZPCRWEB_SETTINGS_VERSION,
} from "../zpcrwebSettings.js";
import { plateToCsv } from "../plateCsv.js";
import { formatRunDefinitionText } from "../prcl.js";
import {
  parseRunDefinition,
  splitRunDefinition,
  SCAN_MASK_CHANNELS,
  type RunDefinitionProgram,
} from "../runDefinition.js";
import { assertCommandArgument } from "./commands.js";

/** Where a run's files live on the instrument (`usb.md` §5). */
export const CFX_CURRENT_RUN_DIR = "\\Storage Card\\CurrentRun";

/** Where the `.alf` run report lands, and what §7.1 empties before a run. */
export const CFX_RUN_REPORT_DIR = "\\Storage Card\\PCRunReport";

/**
 * The name `PROTOCOL` announces, sent verbatim as the capture shows it.
 *
 * Not the run's name, which is a distinct thing `RemoteRun` carries: CFX Manager sent
 * `PROTOCOL 'PCRUN'` while starting a run called `singletest`, so this operand is evidently a
 * fixed label for "a protocol typed in over the wire" rather than anything user-facing. Copied
 * rather than improved on — nothing here knows what else the firmware would accept.
 */
export const CFX_PROTOCOL_LABEL = "PCRUN";

/** The marker file the instrument writes for itself, that a `RemoteRun`-started run must deposit
 * instead — see the module comment's fourth file. */
export const PROTOCOL_NAME_TXT = "ProtocolName.txt";

/** `METHOD`'s operand when the run definition carries none. `CALC` in every file and capture. */
const DEFAULT_METHOD = "CALC";

/** The three method names `RemoteRun`'s eighth operand enumerates (`usb.md` §7.3). */
const METHODS = new Set(["CALC", "BLOCK", "OTHER"]);

/** The operator name `RemoteRun` records. `admin` in the capture; nothing reads it back. */
const DEFAULT_USER = "admin";

/** The block letter, the same one `ERRORLIST A` uses. A CFX96 has exactly one. */
const BLOCK = "A";

/** How serious a {@link RunCheck} is — and, for `error`, whether a run may start at all. */
export type RunCheckSeverity =
  /** The run would not produce the data it looks like it produces. Start is blocked. */
  | "error"
  /** Worth reading before starting, but a deliberate operator may proceed. */
  | "warning";

/** One thing worth saying about a planned run before it starts. */
export interface RunCheck {
  severity: RunCheckSeverity;
  /** Short identifier for the rule, so a UI can style or suppress one kind. */
  code:
    | "no-plate-read"
    | "channels-unread"
    | "channels-idle"
    | "flyover-multichannel"
    | "no-steps"
    | "method-unknown"
    | "no-experiment-name"
    | "no-plate";
  message: string;
}

/** One file the plan would upload, with the device path it lands at. */
export interface RunUpload {
  /** The file's name in the run directory — also what it is called inside the resulting `.zpcr`. */
  name: string;
  /** Full device path, `\Storage Card\CurrentRun\<name>`. */
  path: string;
  bytes: Uint8Array;
}

/** A run reduced to exactly what would be sent, plus what is worth knowing about it first. */
export interface RunPlan {
  /** What the run will be called — `RemoteRun`'s run-name operand, and the `.alf` report's name. */
  name: string;
  /** The decoded protocol, so a caller can show the steps it is about to send. */
  program: RunDefinitionProgram;
  /**
   * The ASCII command lines that author the protocol, in order, ending with `END`. Sent before
   * {@link remoteRun} — this is the representation the firmware actually executes (`usb.md` §5.1).
   */
  commands: string[];
  /** The `RemoteRun` line that starts the authored protocol. */
  remoteRun: string;
  /** The files to upload, in the order they are sent. Empty when {@link producesRunFile} is
   * false — see there. */
  uploads: RunUpload[];
  /**
   * Will this run leave a `.zpcr` behind?
   *
   * True for a protocol with a `PLATEREAD`, which is the only kind the instrument builds a run
   * folder for. **Measured**: starting a `METHOD BLOCK` protocol with no `PLATEREAD` leaves
   * `\Storage Card\CurrentRun` untouched from first command to last — same 86 entries before the
   * run, during it and after the §7.6 acknowledgement, with the previous run's `RunInfo.xml`,
   * `ProtocolRunDefinition.txt`, plate reads and `ended` marker all still in place (`usb.md`
   * §7.10). A run folder pulled back after such a run is therefore somebody else's run, not this
   * one, which is exactly how a `.zpcr` came to be assembled out of a stale folder.
   *
   * The one thing such a run does write is its `.alf` report, in `\Storage Card\PCRunReport`.
   *
   * It also decides {@link uploads}: the §7.4 deposit exists to make the *run folder* a
   * self-contained experiment, so with no folder being written there is nothing for it to
   * complete — and the files would land in the previous run's folder, where they are pollution
   * that the next run to be pulled would carry away. So a thermal-only plan deposits nothing and
   * the run is purely the commands.
   */
  producesRunFile: boolean;
  /** What the plate and protocol say about each other — see {@link checkRunPlan}. */
  checks: RunCheck[];
  /** True when no check is an `error`, i.e. this plan may be started. */
  startable: boolean;
}

export interface PlanRunOptions {
  /** The protocol, as the ASCII run definition that would be sent (`prcl.md` §3.1). */
  runDefinition: string;
  /**
   * The plate the run will read. Uploaded as a `.plt.csv`, and checked against `PLATEREAD` when
   * present. Optional: an experiment can be started with no plate attached yet (the app's
   * "pending experiment" model lets one be started from scratch and a plate added later) — when
   * absent, {@link checkRunPlan} is skipped (there is nothing to check channels against) and a
   * single `"no-plate"` warning takes its place instead, so `RunPlan.startable` is unaffected: a
   * `warning` never blocks a start, only an `error` does.
   */
  plate?: PlateDefinition;
  /**
   * What to call the run — required in practice, though typed optional so a caller can build a
   * plan to *look* at before naming it. A blank name is an `error` check, so the plan is not
   * {@link RunPlan.startable} without one.
   *
   * Deliberately never inferred, and the one plausible source is the wrong one: a protocol is run
   * many times, so defaulting to its name would give every run of it the same name — and the name
   * is what the run's `.zpcr` is called (`experiment.ts`'s `runFileBaseName`) and how it is told
   * apart from yesterday's. The instrument can't supply it either: `RemoteRun`'s operand comes
   * back through `STATUS?` uppercased and cut to eight characters (§7.3). Somebody has to type it.
   */
  name?: string;
  /**
   * What the uploaded `.prcl.txt` is called (without the extension) — the protocol's own name,
   * not the run's. Falls back to `protocol`. See {@link PlanRunOptions.plateName}.
   */
  protocolName?: string;
  /**
   * What the uploaded `.plt.csv` is called (without the extension) — the plate setup's own name.
   * Falls back to the plate's {@link PlateDefinition.identityKey} (which is usually the `.pltd`
   * file it was saved from), then to `plate`.
   *
   * Protocols, plates and experiments are three separate namespaces: a protocol and a plate are
   * normally reused across many runs while an experiment name is unique to one, so naming the
   * deposited files after the run would both lose the identity they arrived with and imply that
   * these copies are specific to this run. The run's name reaches the folder through `RemoteRun`
   * (§7.3) and the `.alf` report, which is where it belongs.
   */
  plateName?: string;
  /** `RemoteRun`'s operator field. Purely a label. */
  user?: string;
}

/**
 * Reduce a name to something safe as a `RemoteRun` operand, a device filename, and a command line
 * all at once — three constraints that overlap but aren't the same.
 *
 * `usb.md` §7.3 is strict about the first: none of `RemoteRun`'s string operands may contain
 * `'`, `"`, `,` or `;`, because the first two are the operand quoting, the third is the operand
 * separator and the fourth is the separator between a response's value and its error code. A name
 * carrying any of them either breaks the command or corrupts the reply that comes back — and the
 * reply is how this client knows the run started, so a corrupted one is not a cosmetic problem.
 *
 * The run name also becomes a filename: it reaches `STATUS?` uppercased and truncated to eight
 * characters, and the `.alf` report's name in full (§7.3), so filesystem-hostile punctuation goes
 * too. And anything outside printable ASCII would be rejected by {@link assertCommandArgument}
 * later, at a point where the cause is much harder to see — better a slightly duller name here
 * than an unexplained error from the USB layer.
 */
function safeFileBase(name: string): string {
  return sanitizeName(name) || "zpcrweb";
}

/** {@link safeFileBase}'s character rules, without its fallback — empty in, empty out. */
function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[^\x20-\x7e]/g, "")
    // The four §7.3 operand-syntax characters, then the filename-hostile set.
    .replace(/['",;]+/g, "_")
    .replace(/[\\/:*?<>|]+/g, "_")
    .trim();
}

/**
 * A deposited file's name base: the same character sanitizing as {@link safeFileBase} (the path
 * still has to survive `assertCommandArgument`), minus one trailing extension, and with its own
 * fallback rather than the run name's.
 *
 * The extension goes because these names arrive already carrying one — a plate's `identityKey` is
 * typically `Qualification_Plate_96.pltd`, and a protocol staged from a file keeps its
 * `.prcl.txt` — and `Qualification_Plate_96.pltd.plt.csv` would be a worse name than either.
 * Only a known one is stripped, so a plate called `S183-S185 RVP v2.1` keeps its version.
 */
function uploadBase(name: string | undefined, fallback: string): string {
  const stripped = (name ?? "").replace(/\.(prcl\.txt|plt\.csv|prcl|pltd|zpcr|pcrd|csv|txt)$/i, "");
  return sanitizeName(stripped) || fallback;
}

/** The 1-based optical channels a plate actually uses, from its fluor layers (0-based there). */
function plateChannels(plate: PlateDefinition): number[] {
  const used = new Set<number>();
  for (const fluor of plate.fluors) {
    if (fluor.channel !== undefined) used.add(fluor.channel + 1);
  }
  return [...used].sort((a, b) => a - b);
}

const list = (items: (string | number)[]) => items.join(", ");

/**
 * Check that a protocol's `PLATEREAD` steps will actually read the plate in front of them.
 *
 * This is the one thing a run gets wrong quietly. The scan mask is a property of the *plate*
 * substituted into the protocol when a run starts (`usb.md` §3.1) — CFX Manager derives it from
 * the plate's `scanMode` — but a protocol staged here carries whatever mask its source file
 * recorded, which may have been written for a different plate. A run whose mask omits a channel
 * the plate uses completes normally, reports no error, and produces a `.zpcr` in which that dye's
 * curves are flat zero. Nothing downstream can tell that from a failed reaction, which is why
 * this is an `error` rather than a note.
 *
 * The reverse — reading channels the plate doesn't use — costs only time, and is worth a warning
 * in exactly one case: an all-6 mask over a channel-1-only plate, where the single-channel mask
 * would do the same job faster. `#h81`/`#h01` (channel 1) and `#h3F` (all 6) are the only mask
 * configurations this project has exercised, so for any other plate subset an all-6 mask is the
 * right thing to send and there is nothing to report.
 *
 * `plate` is nullable because an experiment may legitimately have none — the mask comparisons are
 * then simply unanswerable, and everything that is about the protocol alone is still checked.
 */
export function checkRunPlan(
  program: RunDefinitionProgram,
  plate: PlateDefinition | null,
): RunCheck[] {
  const checks: RunCheck[] = [];
  const reads = program.directives.filter((d) => d.verb === "PLATEREAD");
  const used = plate ? plateChannels(plate) : [];

  if (program.steps.length === 0) {
    checks.push({
      severity: "error",
      code: "no-steps",
      message: "This protocol has no steps — there is nothing for the instrument to run.",
    });
  }

  // `RemoteRun`'s eighth operand is an enumeration, not free text (`usb.md` §7.3), and it is the
  // copy `STATUS?` reports back. A protocol carrying something else would be sent verbatim.
  if (program.method !== null && !METHODS.has(program.method.toUpperCase())) {
    checks.push({
      severity: "warning",
      code: "method-unknown",
      message:
        `METHOD ${program.method} is not one of the three names the instrument enumerates ` +
        "(CALC, BLOCK, OTHER). It will be sent as written, and may be rejected.",
    });
  }

  // Worth saying, but never a blocker: an incubation, a reverse-transcription step or any other
  // use of the block as a heated surface is a protocol with no PLATEREAD on purpose, and the
  // instrument runs it perfectly well. It also builds no run folder for one (see
  // `RunPlan.producesRunFile`), so the run leaves behind its report and nothing else — which is
  // the honest outcome, not a failure, but it is a surprise worth stating before the start rather
  // than after.
  if (reads.length === 0) {
    checks.push({
      severity: "warning",
      code: "no-plate-read",
      message:
        "This protocol never reads the plate: it has no PLATEREAD step, so the run will cycle " +
        "temperatures and record no fluorescence at all. That is what an incubation or " +
        "reverse-transcription run wants; a qPCR run needs a plate read. The instrument keeps no " +
        "run folder for such a run, so it will produce a short run report rather than a run file.",
    });
    // Nothing below applies: there is no mask to compare against the plate, and a run that reads
    // nothing has no fluorescence for a plate's well mapping to describe, so a missing plate is
    // not worth mentioning either.
    return checks;
  }

  // A run that *does* read the plate, with no plate attached: the readings still happen and are
  // still kept, they just arrive with nothing saying which well held what. Recoverable after the
  // fact — a plate can be attached to the finished `.zpcr` — so it is advice, not a blocker.
  if (!plate) {
    checks.push({
      severity: "warning",
      code: "no-plate",
      message:
        "No plate is attached, so this run will record no well, target or sample mapping — " +
        "just raw fluorescence. Attach one before starting, or later once it's running.",
    });
    return checks;
  }

  // Every distinct mask, since a melt-curve protocol legitimately carries more than one and they
  // need not agree; a mask that fails is named by its operand so it can be found in the listing.
  const masks = program.scanMasks;
  for (const mask of masks) {
    const missing = used.filter((c) => !mask.channels.includes(c));
    if (missing.length > 0) {
      checks.push({
        severity: "error",
        code: "channels-unread",
        message:
          `PLATEREAD #h${mask.raw.toString(16).toUpperCase()} reads ${mask.summary}, but this ` +
          `plate uses channel${missing.length > 1 ? "s" : ""} ${list(missing)}. Those dyes would ` +
          "record as zero for the whole run.",
      });
    }
    // Only the two mask configurations this project has actually exercised are worth mentioning,
    // and only in the one combination where a *better* mask exists: a channel-1 plate read by an
    // all-6 mask could be read by the single-channel mask instead, for free. A plate using some
    // other subset (say channels 1–3) has no tested narrower mask to switch to — all 6 is the
    // right thing to send — so saying "3 channels are idle" would be noise recommending nothing.
    const idle = mask.channels.filter((c) => !used.includes(c));
    const allChannels = mask.channels.length === SCAN_MASK_CHANNELS;
    const channelOneOnly = used.length === 1 && used[0] === 1;
    if (idle.length > 0 && missing.length === 0 && allChannels && channelOneOnly) {
      checks.push({
        severity: "warning",
        code: "channels-idle",
        message:
          `PLATEREAD #h${mask.raw.toString(16).toUpperCase()} reads ${mask.summary}; the plate ` +
          "uses only channel 1. Reading the other 5 channels costs time per cycle but loses " +
          "nothing.",
      });
    }
    // `#h81` — flyover, channel 1 — is the fast-scan configuration, and the only mask observed
    // with bit 7 set (`usb.md` §3.1). Anything else pairing flyover with several channels is
    // outside what any capture or sample exercises.
    if (mask.flyover && mask.channels.length > 1) {
      checks.push({
        severity: "warning",
        code: "flyover-multichannel",
        message:
          `PLATEREAD #h${mask.raw.toString(16).toUpperCase()} asks for a flyover scan of ` +
          `${mask.channels.length} channels. Only single-channel flyover (#h81) has ever been ` +
          "observed; the instrument may not accept this one.",
      });
    }
  }

  return checks;
}

/**
 * Turn a protocol and a plate into the exact commands and files that would start the run.
 *
 * Pure — nothing here talks to a device, and calling it twice produces the same bytes. See
 * {@link CfxDevice.startRun} for the sending half, and the module comment for why the two are
 * separate.
 */
export function planRun(options: PlanRunOptions): RunPlan {
  const { runDefinition, plate } = options;
  const program = parseRunDefinition(runDefinition);
  const name = safeFileBase(options.name || "");
  const user = options.user ?? DEFAULT_USER;
  const method = program.method ?? DEFAULT_METHOD;

  // `PROTOCOL` first, then the run definition's own directives verbatim, one per line — the
  // order the capture shows, and the reason the text form is what this app stages: what is
  // reviewed on screen is character-for-character what is typed at the instrument.
  const commands = [
    `PROTOCOL '${CFX_PROTOCOL_LABEL}'`,
    ...splitRunDefinition(runDefinition),
  ];

  // Whether the instrument will build a run folder for this at all — see `RunPlan.producesRunFile`
  // for the measurement. Everything deposited below is deposited *into* that folder, so a plan
  // that won't get one deposits nothing.
  const producesRunFile = program.directives.some((d) => d.verb === "PLATEREAD");

  // The deposited files keep the protocol's and the plate's own names, never the run's — see
  // `PlanRunOptions.plateName` for why the three namespaces stay separate.
  const protocolBase = uploadBase(options.protocolName, "protocol");

  const uploads: RunUpload[] = [
    {
      name: `${protocolBase}.prcl.txt`,
      path: `${CFX_CURRENT_RUN_DIR}\\${protocolBase}.prcl.txt`,
      bytes: new TextEncoder().encode(formatRunDefinitionText(runDefinition)),
    },
  ];

  // The instrument writes this itself for a touchscreen- or CFX Manager-started run, but not for
  // one started here (see the module comment's fourth file), so it is deposited as plain text
  // under the protocol's own name — unsanitized, since it is file *content* rather than a name.
  // Only when there is a name: an unnamed protocol has nothing to say, same reasoning as the
  // run-name deposit below.
  const protocolName = (options.protocolName ?? "").trim();
  if (protocolName) {
    uploads.push({
      name: PROTOCOL_NAME_TXT,
      path: `${CFX_CURRENT_RUN_DIR}\\${PROTOCOL_NAME_TXT}`,
      bytes: new TextEncoder().encode(protocolName),
    });
  }

  if (plate) {
    const plateBase = uploadBase(options.plateName || plate.identityKey, "plate");
    uploads.push({
      name: `${plateBase}.plt.csv`,
      path: `${CFX_CURRENT_RUN_DIR}\\${plateBase}.plt.csv`,
      bytes: new TextEncoder().encode(plateToCsv(plate)),
    });
  }

  // The run's *name* rides along too, as a `zpcrweb.json` (`zpcrwebSettings.ts`) — the one field
  // of it that is known before a single cycle has run. Nothing on the instrument reads the entry;
  // its job is to be in the folder when the folder is pulled back, so the archive states what the
  // run is called instead of leaving it to be guessed from a filename the firmware composed. That
  // makes the name survive a browser reload, a different machine, or a rename on disk — the same
  // reason a name typed in Overview is written into the archive rather than kept in IndexedDB.
  //
  // Only when there is a name: an unnamed run has nothing to say, and an entry asserting the
  // protocol's name as the experiment's would be worse than none (`experiment.ts` would then
  // stop deriving one).
  const experimentName = (options.name ?? "").trim();
  if (experimentName) {
    // No `updatedAt`: `planRun` is pure — same inputs, same bytes — and a timestamp here would
    // also be the plan's build time rather than the run's, which `RunInfo.xml` already records.
    const settings = formatZpcrwebSettings({
      version: ZPCRWEB_SETTINGS_VERSION,
      generator: "zpcrweb",
      experimentName,
    });
    uploads.push({
      name: ZPCRWEB_SETTINGS_NAME,
      path: `${CFX_CURRENT_RUN_DIR}\\${ZPCRWEB_SETTINGS_NAME}`,
      bytes: new TextEncoder().encode(settings),
    });
  }

  for (const upload of uploads) assertCommandArgument("upload path", upload.path);

  // Eight positional operands, defined one by one in `usb.md` §7.3. Sent exactly as the capture
  // does, and each of the three booleans is the value a host-driven run wants:
  //   <block>        "A" — a CFX96 has one, and it is the letter `ERRORLIST A` also takes
  //   <lid on>       True — use the heated lid, whose temperature `HOTLID` already set
  //   <remote start> False — start now, rather than staging it for the touchscreen's own start
  //   <run name>     what the run is called; reaches STATUS? and the .alf report's filename
  //   <user>         free text, recorded in the report
  //   <sample ID>    free text, empty here as in the capture
  //   <sierra mode>  True — the instrument drives its own optics and writes its own plate reads,
  //                  which is what lets the run survive this browser going away
  //   <method>       repeated from METHOD; this is the copy STATUS? reports back
  const safeUser = safeFileBase(user);
  const remoteRun =
    `RemoteRun "${BLOCK}","True","False","${name}","${safeUser}","","True","${method}"`;
  assertCommandArgument("RemoteRun", remoteRun);

  // The name is a property of the run rather than of the protocol/plate pair, so it is checked
  // here rather than in `checkRunPlan` — but it is an `error` like any other, which is what makes
  // Start run refuse an unnamed run without the UI needing a rule of its own. First in the list:
  // it is the check the operator can act on before the run exists at all.
  const checks = checkRunPlan(program, plate ?? null);
  if (!experimentName) {
    checks.unshift({
      severity: "error",
      code: "no-experiment-name",
      // A thermal-only run has no file to be named after it, but the name is still what the
      // instrument's own report is filed under, so it is still required — just for a different
      // reason, and saying the wrong one would send someone looking for a file that never comes.
      message: producesRunFile
        ? "Name this experiment before starting it — the run's file is named after it."
        : "Name this run before starting it — the instrument's run report is filed under it.",
    });
  }
  return {
    name,
    program,
    commands,
    remoteRun,
    // Deposited into the run folder, so only when there will be one. See `producesRunFile`.
    uploads: producesRunFile ? uploads : [],
    checks,
    producesRunFile,
    startable: !checks.some((c) => c.severity === "error"),
  };
}
