import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export class LabMetrics {
  readonly registry: Registry;

  readonly devices: Gauge;
  readonly queueDepth: Gauge;
  readonly queueWaitSeconds: Histogram;
  readonly sessionsStarted: Counter;
  readonly sessionsEnded: Counter;
  readonly allocationSeconds: Histogram;
  readonly cleanupSeconds: Histogram;
  readonly framesProduced: Counter;
  readonly framesSent: Counter;
  readonly framesDropped: Counter;
  readonly inputCommands: Counter;
  readonly inputApplySeconds: Histogram;
  readonly recoveries: Counter;

  constructor(withDefaults = true) {
    this.registry = new Registry();
    if (withDefaults) collectDefaultMetrics({ register: this.registry });

    this.devices = new Gauge({
      name: "lab_devices",
      help: "Devices by state",
      labelNames: ["state"],
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: "lab_queue_depth",
      help: "Waiting queue entries",
      registers: [this.registry],
    });
    this.queueWaitSeconds = new Histogram({
      name: "lab_queue_wait_seconds",
      help: "Time from enqueue to reservation",
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
      registers: [this.registry],
    });
    this.sessionsStarted = new Counter({
      name: "lab_sessions_started_total",
      help: "Sessions activated",
      registers: [this.registry],
    });
    this.sessionsEnded = new Counter({
      name: "lab_sessions_ended_total",
      help: "Sessions ended by reason",
      labelNames: ["reason"],
      registers: [this.registry],
    });
    this.allocationSeconds = new Histogram({
      name: "lab_allocation_seconds",
      help: "Duration of one allocation transaction",
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
      registers: [this.registry],
    });
    this.cleanupSeconds = new Histogram({
      name: "lab_cleanup_seconds",
      help: "Device cleanup duration",
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });
    this.framesProduced = new Counter({
      name: "lab_stream_frames_produced_total",
      help: "Frames captured from devices",
      labelNames: ["deviceId"],
      registers: [this.registry],
    });
    this.framesSent = new Counter({
      name: "lab_stream_frames_sent_total",
      help: "Frames written to client sockets",
      registers: [this.registry],
    });
    this.framesDropped = new Counter({
      name: "lab_stream_frames_dropped_total",
      help: "Frames replaced by newer frames under backpressure",
      registers: [this.registry],
    });
    this.inputCommands = new Counter({
      name: "lab_input_commands_total",
      help: "Input commands by kind and status",
      labelNames: ["kind", "status"],
      registers: [this.registry],
    });
    this.inputApplySeconds = new Histogram({
      name: "lab_input_apply_seconds",
      help: "ADB apply duration by kind",
      labelNames: ["kind"],
      buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2],
      registers: [this.registry],
    });
    this.recoveries = new Counter({
      name: "lab_recoveries_total",
      help: "Recovery actions by reason",
      labelNames: ["reason"],
      registers: [this.registry],
    });
  }
}
