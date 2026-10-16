/**
 * CFX96 / C1000 Touch USB client — see `usb.md` for the protocol this implements.
 *
 * Isomorphic: obtain a `USBDevice` from `navigator.usb` in a browser or from node-usb's `WebUSB`
 * in Node, and hand it to {@link CfxDevice}. Everything above the device handle is shared — see
 * `transport.ts`'s module comment for why there is only one implementation.
 */
export { CfxDevice } from "./device.js";
export type {
  CfxAwaitStartOptions,
  CfxCancelOptions,
  CfxCancelResult,
  CfxDeviceOptions,
  CfxDirectory,
  CfxReleaseOptions,
  CfxReleaseResult,
  CfxRunStartResult,
  CfxTrafficEvent,
  CfxTransferErrorEvent,
  CfxUploadResult,
} from "./device.js";
export {
  cfxFileCrc,
  formatCfxFileCrc,
} from "./crc.js";
export {
  CFX_CURRENT_RUN_DIR,
  CFX_PROTOCOL_LABEL,
  CFX_RUN_REPORT_DIR,
  checkRunPlan,
  planRun,
} from "./runPlan.js";
export type {
  PlanRunOptions,
  RunCheck,
  RunCheckSeverity,
  RunPlan,
  RunUpload,
} from "./runPlan.js";
export {
  CFX_COMMANDS,
  CFX_DIRECTORIES,
  CfxCommandError,
  OK_CODE,
  assertCommandArgument,
  encodeCommand,
  parseResponse,
  setDateTimeCommand,
} from "./commands.js";
export type {
  CfxCommandName,
  CfxCommandSpec,
  CfxResponse,
  CommandConfidence,
} from "./commands.js";
export {
  FRAME_HEADER_BYTES,
  FrameReassembler,
  REQUEST_HEADER,
  decodeHeader,
  encodeFrame,
} from "./frame.js";
export type { CfxFrameHeader, CfxMessage } from "./frame.js";
export { CfxSession, RECONNECT_DELAYS_MS } from "./session.js";
export type {
  ActionResult,
  CfxSessionOptions,
  CfxSessionState,
  ConnectionState,
  ConsoleLine,
  LastRunReport,
  TrafficLine,
  TransferErrorLine,
} from "./session.js";
export { RunFollower } from "./runFollower.js";
export type {
  CheckReason,
  HeldRun,
  RunFollowerMemory,
  RunFollowerPorts,
  RunFollowerState,
} from "./runFollower.js";
export { parseIdentity, parseRtStatus, parseStatus, isPaused, isFinishedRun } from "./status.js";
export type {
  CfxDeviceInfo,
  CfxFault,
  CfxIdentity,
  CfxRtStatus,
  CfxRunPhase,
  CfxStatus,
  CfxStatusFlags,
  LidState,
} from "./status.js";
export {
  CFX_CONFIGURATION,
  CFX_ENDPOINT_IN,
  CFX_ENDPOINT_OUT,
  CFX_INTERFACE,
  CFX_PRODUCT_ID,
  CFX_READ_CHUNK,
  CFX_USB_FILTER,
  CFX_VENDOR_ID,
  transferBytes,
} from "./transport.js";
export type { UsbDeviceLike, UsbInTransferResultLike } from "./transport.js";
