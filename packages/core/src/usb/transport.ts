/**
 * The transport under {@link CfxDevice}, and the one place browser and Node differ.
 *
 * ## Why there is only one implementation
 *
 * The obvious design here is two backends — WebUSB in the browser, `libusb` in Node — behind an
 * abstract interface, with the bulk-transfer calls written twice. That isn't necessary, because
 * **node-usb already ships a WebUSB implementation**: `new WebUSB({…})` from the `usb` package
 * hands back `USBDevice` objects with the same `open`/`selectConfiguration`/`claimInterface`/
 * `transferIn`/`transferOut` surface `navigator.usb` produces. The two environments differ only
 * in *how you obtain the device*, not in how you talk to it.
 *
 * So the split is drawn there and nowhere else. {@link UsbDeviceLike} describes the handful of
 * `USBDevice` members this protocol actually uses; both a real browser `USBDevice` and node-usb's
 * satisfy it structurally, with no adapter and no `instanceof` on either side. Everything above
 * this file — framing, the command layer, file transfer — is written once and is environment-free.
 *
 * It is deliberately a *structural* interface rather than a re-export of `USBDevice` from
 * `@types/w3c-web-usb`: `packages/core` is isomorphic and dependency-light (see the root
 * `ARCHITECTURE.md`), and taking a DOM type dependency to name a shape this small would push a
 * browser-typings requirement onto every consumer, Node included.
 *
 * Callers get the device from whichever side they are on:
 *
 * ```ts
 * // Browser
 * const device = await navigator.usb.requestDevice({ filters: [CFX_USB_FILTER] });
 * // Node
 * const { WebUSB } = await import("usb");
 * const device = await new WebUSB({ allowAllDevices: true }).requestDevice({ filters: [CFX_USB_FILTER] });
 * ```
 *
 * and pass it to `new CfxDevice(device)` either way.
 */

/** `usb.md` §1 — Bio-Rad's vendor id. A `requestDevice` filter on this alone is what the one
 * vendor-specific interface wants; no OS class driver binds it. */
export const CFX_VENDOR_ID = 0x0614;
/** C1000 Touch Thermal Cycler, the base unit a CFX96 optical head rides on. Other Bio-Rad models
 * likely share the vendor id with their own product id, but none were captured (`usb.md` §9), so
 * the default filter deliberately matches on vendor alone. */
export const CFX_PRODUCT_ID = 0x057b;

/** The filter to pass to `requestDevice`. Vendor-only, per the note on {@link CFX_PRODUCT_ID}. */
export const CFX_USB_FILTER = { vendorId: CFX_VENDOR_ID } as const;

/** The one vendor-specific interface (`usb.md` §1). */
export const CFX_INTERFACE = 0;
export const CFX_CONFIGURATION = 1;
/** Bulk OUT, host → device. */
export const CFX_ENDPOINT_OUT = 2;
/** Bulk IN, device → host. */
export const CFX_ENDPOINT_IN = 6;
/**
 * Read size per `transferIn`. Not a protocol limit — the USB max packet size is 64 and the driver
 * stack coalesces — but the same 4096-byte read buffer CFX Manager uses for large files
 * (`usb.md` §2), which is a comfortable size for `GETFILE` without being wasteful on a 20-byte
 * status reply.
 */
export const CFX_READ_CHUNK = 4096;

/** The subset of WebUSB's `USBInTransferResult` this code reads. */
export interface UsbInTransferResultLike {
  data?: DataView | null;
}

/** Spelled out rather than using the DOM's `BufferSource`, which core's Node-only typings don't
 * provide — see the module comment on not depending on browser types. */
type BytesLike = ArrayBuffer | ArrayBufferView;

/**
 * The subset of WebUSB's `USBDevice` this protocol uses. Satisfied structurally by a browser
 * `USBDevice` and by node-usb's WebUSB device alike — see the module comment.
 */
export interface UsbDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly manufacturerName?: string;
  readonly serialNumber?: string;
  readonly opened?: boolean;
  readonly configuration?: unknown;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<UsbInTransferResultLike>;
  /** Clear a halted endpoint. Optional: a browser `USBDevice` always has it, but the structural
   * typing here also covers devices that may not, and the read pump treats it as best-effort. */
  clearHalt?(direction: "in" | "out", endpointNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: BytesLike): Promise<unknown>;
}

/** Copy a transfer result's payload out as bytes. `transferIn` yields a `DataView` over a buffer
 * that may be larger than the transfer; slicing by the view's own offset/length is what keeps a
 * short read from picking up neighbouring bytes. */
export function transferBytes(result: UsbInTransferResultLike): Uint8Array {
  const view = result.data;
  if (!view) return new Uint8Array(0);
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}
