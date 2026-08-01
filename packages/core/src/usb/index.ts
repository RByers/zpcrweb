/**
 * CFX96 / C1000 Touch USB client — see `usb.md` for the protocol this implements.
 *
 * Isomorphic: obtain a `USBDevice` from `navigator.usb` in a browser or from node-usb's `WebUSB`
 * in Node, and hand it to {@link CfxDevice}. Everything above the device handle is shared — see
 * `transport.ts`'s module comment for why there is only one implementation.
 */
export { CfxDevice } from "./device.js";
export type { CfxDeviceOptions, CfxDirectory, CfxTrafficEvent } from "./device.js";
export {
  CFX_COMMANDS,
  CFX_DIRECTORIES,
  CfxCommandError,
  OK_CODE,
  assertCommandArgument,
  encodeCommand,
  parseResponse,
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
export { parseIdentity, parseRtStatus, parseStatus } from "./status.js";
export type {
  CfxDeviceInfo,
  CfxIdentity,
  CfxRtStatus,
  CfxStatus,
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
