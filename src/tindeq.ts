// Web Bluetooth client for the Tindeq Progressor.
//
// Protocol reference: https://tindeq.com/progressor_api/ and the official
// Python sample. The device exposes a custom "Progressor" GATT service with a
// control-point characteristic (write commands) and a data-point characteristic
// (notifications). All multi-byte values are little-endian.

export const PROGRESSOR_SERVICE_UUID = "7e4e1701-1ea6-40c9-9dcc-13d34ffead57";
const DATA_CHAR_UUID = "7e4e1702-1ea6-40c9-9dcc-13d34ffead57";
const CONTROL_CHAR_UUID = "7e4e1703-1ea6-40c9-9dcc-13d34ffead57";

// Commands written to the control point.
const CMD_TARE_SCALE = 0x64;
const CMD_START_WEIGHT_MEAS = 0x65;
const CMD_STOP_WEIGHT_MEAS = 0x66;
const CMD_ENTER_SLEEP = 0x6e;

// Response kinds on the data point.
const RSP_WEIGHT_MEASURE = 0x01;

// How long to wait for a silent reconnect to a remembered device before giving
// up and showing the picker (the device may be off or out of range).
const GATT_CONNECT_TIMEOUT_MS = 5000;

/** Reject with `message` if `promise` doesn't settle within `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Thrown when the user closes the device chooser without picking a device. */
export class UserCancelledError extends Error {
  constructor() {
    super("Device selection cancelled");
    this.name = "UserCancelledError";
  }
}

export interface ForceSample {
  /** Force in kg. */
  weight: number;
  /** Device timestamp in microseconds since measurement start. */
  timestampUs: number;
}

export interface TindeqCallbacks {
  onSample?: (sample: ForceSample) => void;
  onDisconnect?: () => void;
}

export class TindeqProgressor {
  private device: BluetoothDevice | null = null;
  private controlChar: BluetoothRemoteGATTCharacteristic | null = null;
  private dataChar: BluetoothRemoteGATTCharacteristic | null = null;
  private callbacks: TindeqCallbacks;

  constructor(callbacks: TindeqCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  async connect(): Promise<void> {
    if (!TindeqProgressor.isSupported()) {
      throw new Error(
        "Web Bluetooth is not available in this browser. Use Chrome, Edge, or another Chromium-based browser.",
      );
    }

    // Fast path: if we've already been granted access to a Progressor in a
    // previous session, try to reconnect to it silently — no chooser. This only
    // works if the device is powered on and in range right now; otherwise we
    // fall through to the picker below.
    const remembered = await this.findRememberedDevice();
    if (remembered) {
      try {
        await this.setupDevice(remembered);
        return;
      } catch (e) {
        console.warn(
          "[tindeq] auto-connect to remembered device failed; showing picker",
          e,
        );
        await this.cleanupFailedDevice();
      }
    }

    // The Progressor advertises by name ("Progressor_XXXX") and does NOT put its
    // 128-bit service UUID in the advertisement packet, so a `services` filter
    // matches nothing. Filter by name prefix and list the service as optional so
    // we're still allowed to access it after connecting.
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "Progressor" }],
        optionalServices: [PROGRESSOR_SERVICE_UUID],
      });
    } catch (e) {
      // requestDevice throws NotFoundError specifically when the user closes the
      // chooser. Translate it so callers don't confuse it with a missing GATT
      // service/characteristic (which also throws NotFoundError, later).
      if (e instanceof DOMException && e.name === "NotFoundError") {
        throw new UserCancelledError();
      }
      throw e;
    }

    await this.setupDevice(device);
  }

  /**
   * Return a previously-permitted Progressor, if the browser supports
   * `getDevices()` and one is remembered. Never throws.
   */
  private async findRememberedDevice(): Promise<BluetoothDevice | null> {
    // getDevices() is Chromium-only and may be gated behind
    // chrome://flags/#enable-web-bluetooth-new-permissions-backend on some
    // versions, so guard both the method and the call.
    if (typeof navigator.bluetooth.getDevices !== "function") return null;
    try {
      const devices = await navigator.bluetooth.getDevices();
      return devices.find((d) => d.name?.startsWith("Progressor")) ?? null;
    } catch (e) {
      console.warn("[tindeq] getDevices() failed", e);
      return null;
    }
  }

  /** Connect to a device, discover characteristics, and start notifications. */
  private async setupDevice(device: BluetoothDevice): Promise<void> {
    this.device = device;
    device.addEventListener("gattserverdisconnected", this.handleDisconnect);

    console.log("[tindeq] connecting to GATT server…");
    // A remembered device that's out of range leaves gatt.connect() pending
    // indefinitely, so bound it and fall back to the picker on timeout.
    const server = await withTimeout(
      device.gatt!.connect(),
      GATT_CONNECT_TIMEOUT_MS,
      "GATT connect timed out (device out of range?)",
    );
    console.log("[tindeq] discovering service", PROGRESSOR_SERVICE_UUID);
    const service = await server.getPrimaryService(PROGRESSOR_SERVICE_UUID);

    console.log("[tindeq] discovering characteristics…");
    this.controlChar = await service.getCharacteristic(CONTROL_CHAR_UUID);
    this.dataChar = await service.getCharacteristic(DATA_CHAR_UUID);

    this.dataChar.addEventListener(
      "characteristicvaluechanged",
      this.handleNotification,
    );
    await this.dataChar.startNotifications();
    console.log("[tindeq] notifications started; ready");
  }

  /** Tear down a half-open device after a failed auto-connect attempt. */
  private async cleanupFailedDevice(): Promise<void> {
    this.device?.removeEventListener(
      "gattserverdisconnected",
      this.handleDisconnect,
    );
    try {
      this.device?.gatt?.disconnect();
    } catch {
      // ignore — best effort
    }
    this.device = null;
    this.controlChar = null;
    this.dataChar = null;
  }

  private handleDisconnect = () => {
    this.controlChar = null;
    this.dataChar = null;
    this.callbacks.onDisconnect?.();
  };

  private handleNotification = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;
    this.parsePacket(value);
  };

  // A weight-measure packet is: [kind, length, payload...]. The payload is a
  // sequence of 8-byte samples, each a float32 weight (kg) followed by a uint32
  // timestamp in microseconds. Packets may batch several samples.
  private parsePacket(view: DataView): void {
    if (view.byteLength < 2) return;
    const kind = view.getUint8(0);
    const length = view.getUint8(1);
    if (kind !== RSP_WEIGHT_MEASURE) return;

    for (let offset = 2; offset + 8 <= 2 + length && offset + 8 <= view.byteLength; offset += 8) {
      const weight = view.getFloat32(offset, true);
      const timestampUs = view.getUint32(offset + 4, true);
      this.callbacks.onSample?.({ weight, timestampUs });
    }
  }

  private async sendCommand(opcode: number): Promise<void> {
    if (!this.controlChar) throw new Error("Not connected");
    await this.controlChar.writeValue(new Uint8Array([opcode]));
  }

  /**
   * Zero the scale. Do this with no load on the device.
   *
   * Taring ends the current measurement on the device: the notifications stop
   * and the displayed weight freezes on the last sample until measurement is
   * started again (which is why a disconnect/reconnect appeared to "fix" it).
   * Restart the stream here so the tare is invisible apart from the new zero.
   */
  async tare(): Promise<void> {
    await this.sendCommand(CMD_TARE_SCALE);
    await this.startMeasurement();
  }

  startMeasurement(): Promise<void> {
    return this.sendCommand(CMD_START_WEIGHT_MEAS);
  }

  stopMeasurement(): Promise<void> {
    return this.sendCommand(CMD_STOP_WEIGHT_MEAS);
  }

  async disconnect(): Promise<void> {
    try {
      if (this.controlChar) {
        await this.stopMeasurement().catch(() => {});
        await this.sendCommand(CMD_ENTER_SLEEP).catch(() => {});
      }
    } finally {
      this.device?.removeEventListener(
        "gattserverdisconnected",
        this.handleDisconnect,
      );
      this.device?.gatt?.disconnect();
      this.device = null;
      this.controlChar = null;
      this.dataChar = null;
    }
  }
}
