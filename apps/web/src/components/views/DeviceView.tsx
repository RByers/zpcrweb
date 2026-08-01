/**
 * The Device view — a live CFX96 over WebUSB, rather than a file.
 *
 * It is the one view that operates on no `LoadedFile` at all, which is why `App` hides the file
 * bar while it is showing and why its tab sits apart from the others (see `ViewSelector`). Layout
 * reuses the Curves view's rail + content grid so it reads as the same kind of surface: the rail
 * carries connection, identity, status and actions, and the content column stacks the file
 * browser above the traffic console.
 */
import { DeviceRail } from "../device/DeviceRail";
import { DeviceFiles } from "../device/DeviceFiles";
import { DeviceConsole } from "../device/DeviceConsole";
import { useCfxDevice } from "../../state/useCfxDevice";

export function DeviceView() {
  const device = useCfxDevice();
  return (
    <div className="curves device">
      <DeviceRail device={device} />
      <div className="device__content">
        <DeviceFiles device={device} />
        <DeviceConsole device={device} />
      </div>
    </div>
  );
}
