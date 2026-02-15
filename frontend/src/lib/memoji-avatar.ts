/**
 * Memoji avatar — manages looping video states and one-shot scripted videos.
 *
 * Ported from jenny/src/avatar.js.  Operates imperatively on a container
 * HTMLDivElement provided by the React host (via ref).
 */

export type AvatarState =
  | "idle"
  | "thinking"
  | "talking"
  | "happy"
  | "excited"
  | "concerned";

const STATES: AvatarState[] = [
  "idle",
  "thinking",
  "talking",
  "happy",
  "excited",
  "concerned",
];

export class MemojiAvatar {
  private container: HTMLDivElement;
  private videos: Partial<Record<AvatarState, HTMLVideoElement>> = {};
  private currentVideo: HTMLVideoElement | null = null;
  private scriptedVideo: HTMLVideoElement | null = null;
  private currentState: AvatarState = "idle";
  private revertTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLDivElement) {
    this.container = container;
  }

  async init(): Promise<void> {
    // Create a looping <video> for each state
    for (const state of STATES) {
      const video = document.createElement("video");
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = `/avatar/loops/${state}.mp4`;
      video.style.display = "none";
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = "cover";
      this.container.appendChild(video);
      this.videos[state] = video;
      video.load();
    }

    // One scripted-response video element (unmuted — has baked-in audio)
    const scripted = document.createElement("video");
    scripted.loop = false;
    scripted.muted = false;
    scripted.playsInline = true;
    scripted.preload = "auto";
    scripted.style.display = "none";
    scripted.style.width = "100%";
    scripted.style.height = "100%";
    scripted.style.objectFit = "cover";
    this.container.appendChild(scripted);
    this.scriptedVideo = scripted;

    // When a scripted clip finishes, go back to idle
    scripted.addEventListener("ended", () => {
      scripted.style.display = "none";
      this.setState("idle");
    });

    // Start on idle
    this.setState("idle");
  }

  setState(state: AvatarState): void {
    const video = this.videos[state];
    if (!video) return;

    // Hide scripted video if it was playing
    if (this.scriptedVideo) {
      this.scriptedVideo.pause();
      this.scriptedVideo.style.display = "none";
    }

    // Hide current looping video
    if (this.currentVideo) {
      this.currentVideo.pause();
      this.currentVideo.style.display = "none";
    }

    // Show + play new looping video
    this.currentVideo = video;
    video.style.display = "block";
    video.currentTime = 0;
    video.play().catch(() => {});

    this.currentState = state;
  }

  /** Play a one-shot scripted video with baked-in audio. Resolves when done. */
  async playScriptedVideo(videoPath: string): Promise<void> {
    const scripted = this.scriptedVideo;
    if (!scripted) return;

    return new Promise<void>((resolve) => {
      // Hide current looping video
      if (this.currentVideo) {
        this.currentVideo.pause();
        this.currentVideo.style.display = "none";
      }

      scripted.src = videoPath;
      scripted.style.display = "block";

      const onEnded = () => {
        scripted.removeEventListener("ended", onEnded);
        resolve();
      };
      scripted.addEventListener("ended", onEnded);

      const onError = () => {
        scripted.removeEventListener("error", onError);
        this.setState("idle");
        resolve();
      };
      scripted.addEventListener("error", onError, { once: true });

      scripted.play().catch(() => {
        this.setState("idle");
        resolve();
      });
    });
  }

  // ── Convenience state helpers ──

  idle(): void {
    this.clearRevertTimer();
    this.setState("idle");
  }

  thinking(): void {
    this.clearRevertTimer();
    this.setState("thinking");
  }

  talking(): void {
    this.clearRevertTimer();
    this.setState("talking");
  }

  happy(): void {
    this.clearRevertTimer();
    this.setState("happy");
    this.revertTimer = setTimeout(() => {
      if (this.currentState === "happy") this.idle();
    }, 5000);
  }

  excited(): void {
    this.clearRevertTimer();
    this.setState("excited");
    this.revertTimer = setTimeout(() => {
      if (this.currentState === "excited") this.idle();
    }, 5000);
  }

  concerned(): void {
    this.clearRevertTimer();
    this.setState("concerned");
  }

  destroy(): void {
    this.clearRevertTimer();
    for (const video of Object.values(this.videos)) {
      video?.pause();
      video?.remove();
    }
    this.scriptedVideo?.pause();
    this.scriptedVideo?.remove();
    this.videos = {};
    this.scriptedVideo = null;
    this.currentVideo = null;
  }

  private clearRevertTimer(): void {
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
  }
}
