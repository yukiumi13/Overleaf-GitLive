import { Identity, compile, downloadPdf, CompileResult } from './api';
import { SessionManager } from './sessionManager';

export type PdfUpdateCallback = (pdfBuffer: Buffer, buildId: string) => void;

export class PdfPoller {
    private timer: ReturnType<typeof setInterval> | undefined;
    private lastBuildId: string | undefined;
    private polling = false;
    private _isStarted = false;

    constructor(
        private identity: Identity,
        private intervalMs: number = 10000,
        private onUpdate: PdfUpdateCallback,
        private onError: (msg: string) => void,
        private onStatus: (msg: string) => void,
        private session?: SessionManager,
    ) { }

    start() {
        if (this._isStarted) { return; }
        this._isStarted = true;
        this.onStatus('PDF preview started');
        this.poll(); // immediate first poll
        if (this.intervalMs > 0) {
            this.timer = setInterval(() => this.poll(), this.intervalMs);
        }
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this._isStarted = false;
        this.onStatus('PDF preview stopped');
    }

    get isRunning(): boolean {
        return this._isStarted;
    }

    /** Trigger a single compile+download cycle (e.g. after push). */
    triggerOnce(): void {
        if (!this._isStarted) { return; }
        this.poll();
    }

    private async poll() {
        if (this.polling) { return; }
        this.polling = true;

        try {
            this.onStatus('Compiling...');
            const id = this.session ? this.session.identity : this.identity;
            const result: CompileResult = await compile(id, this.session);

            if (!result.success) {
                this.onError(`Compile failed: ${result.error}`);
                this.polling = false;
                return;
            }

            if (!result.buildId || !result.pdfUrl) {
                this.onError('No PDF in compile output');
                this.polling = false;
                return;
            }

            if (result.buildId === this.lastBuildId) {
                this.onStatus('No changes detected');
                this.polling = false;
                return;
            }

            this.onStatus('Downloading PDF...');
            const currentId = this.session ? this.session.identity : this.identity;
            const pdfBuffer = await downloadPdf(
                currentId.serverUrl,
                currentId.cookies,
                result.pdfUrl,
                this.session,
                result.clsiServerId,
            );

            this.lastBuildId = result.buildId;
            this.onUpdate(pdfBuffer, result.buildId);
            this.onStatus(`Updated (build: ${result.buildId.slice(0, 12)}...)`);
        } catch (err: any) {
            this.onError(`Poll error: ${err.message}`);
        }

        this.polling = false;
    }
}
