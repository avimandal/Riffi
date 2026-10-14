import workletUrl from './capture.worklet.js?url';
import { micStarted, micStopped, micWillStart } from './session';

export type FramesHandler = (samples: Float32Array, contextTimeSec: number) => void;

export class MicError extends Error {
  constructor(
    message: string,
    readonly reason: 'denied' | 'notfound' | 'insecure' | 'unsupported' | 'other',
  ) {
    super(message);
  }
}

const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * Microphone input via AudioWorklet. Echo cancellation on by default (helps
 * with the metronome); the tuner turns it off when no metronome is playing.
 * Noise suppression and auto gain are always off (they damage instrument sound
 * and bend pitch).
 */
export class MicInput {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private handlers = new Set<FramesHandler>();
  /** Holding the audio session in 'play-and-record' (see ./session). */
  private holdsSession = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly echoCancellation = true,
  ) {}

  onFrames(h: FramesHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  get running(): boolean {
    return !!this.stream;
  }

  get deviceLabel(): string {
    return this.stream?.getAudioTracks()[0]?.label ?? '';
  }

  async start(): Promise<void> {
    if (this.stream) return;
    if (!window.isSecureContext) throw new MicError('Needs HTTPS', 'insecure');
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('No microphone support', 'unsupported');
    // iOS: switch to play-and-record before the mic opens (keeps sound on the loudspeaker, through the silent switch).
    if (!this.holdsSession) {
      micWillStart();
      this.holdsSession = true;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: this.echoCancellation,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.releaseSession();
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('Mic permission denied', 'denied');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('No microphone found', 'notfound');
      throw new MicError(String(err), 'other');
    }
    if (!loadedContexts.has(this.ctx)) {
      await this.ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(this.ctx);
    }
    micStarted();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'riffi-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    this.node.port.onmessage = (ev: MessageEvent<{ samples: Float32Array; frame: number }>) => {
      const t = ev.data.frame / this.ctx.sampleRate;
      this.handlers.forEach((h) => h(ev.data.samples, t));
    };
    // Some browsers only run a worklet that reaches the destination; keep it silent.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.releaseSession();
  }

  private releaseSession() {
    if (!this.holdsSession) return;
    this.holdsSession = false;
    micStopped();
  }
}
