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

    // The Progressor advertises by name ("Progressor_XXXX") and does NOT put its
    // 128-bit service UUID in the advertisement packet, so a `services` filter
    // matches nothing. Filter by name prefix and list the service as optional so
    // we're still allowed to access it after connecting.
    try {
      this.device = await navigator.bluetooth.requestDevice({
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

    this.device.addEventListener("gattserverdisconnected", this.handleDisconnect);

    console.log("[tindeq] connecting to GATT server…");
    const server = await this.device.gatt!.connect();
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

  /** Zero the scale. Do this with no load on the device. */
  tare(): Promise<void> {
    return this.sendCommand(CMD_TARE_SCALE);
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
