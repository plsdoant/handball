// Loads the MediaPipe face / hand / pose landmarkers and runs them on video frames.
// Everything runs locally in the browser; only the WASM runtime and model files
// are fetched from public CDNs.

const MP_VERSION = '1.0.1';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

export class Tracker {
  constructor() {
    this.ready = false;
    this.face = null;
    this.hands = null;
    this.pose = null;
    this.connections = null;
    this.lastTs = 0;
    this.frameId = 0;
    this.lastVideoTime = -1;
    this.done = { hands: 0, face: 0, pose: 0 };
    this.timings = { hands: 0, face: 0, pose: 0, total: 0 };
  }

  async init() {
    const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
    const { FilesetResolver, FaceLandmarker, HandLandmarker, PoseLandmarker } = vision;
    const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);

    const create = async (Cls, model, opts) => {
      try {
        return await Cls.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: model, delegate: 'GPU' },
          runningMode: 'VIDEO',
          ...opts,
        });
      } catch (err) {
        console.warn('GPU delegate failed, falling back to CPU', err);
        return Cls.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: model, delegate: 'CPU' },
          runningMode: 'VIDEO',
          ...opts,
        });
      }
    };

    [this.face, this.hands, this.pose] = await Promise.all([
      create(FaceLandmarker, MODELS.face, {
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
      create(HandLandmarker, MODELS.hand, {
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
      create(PoseLandmarker, MODELS.pose, {
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
    ]);

    // The first inference compiles GPU shaders and can stall for seconds; do it now, while the
    // intro is showing, instead of on the first camera frame.
    const warm = document.createElement('canvas');
    warm.width = 640;
    warm.height = 480;
    const g = warm.getContext('2d');
    g.fillStyle = '#556';
    g.fillRect(0, 0, 640, 480);
    this.lastTs = Math.round(performance.now());
    this.face.detectForVideo(warm, this.lastTs);
    this.hands.detectForVideo(warm, this.lastTs);
    this.pose.detectForVideo(warm, this.lastTs);

    this.connections = {
      faceOval: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
      lips: FaceLandmarker.FACE_LANDMARKS_LIPS,
      leftEye: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
      rightEye: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
      leftBrow: FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
      rightBrow: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
    };
    this.ready = true;
  }

  /**
   * Call once per animation frame. Runs the landmarkers that haven't seen the latest video frame,
   * stalest first (hands win ties), until the per-frame time budget is spent. On fast machines all
   * three run immediately; on slow ones the work spreads over a few frames instead of stalling one.
   */
  detect(video, budgetMs = 12) {
    if (!this.ready) return null;
    if (video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      this.frameId++;
    }
    const out = {};
    let ran = false;
    const start = performance.now();
    for (;;) {
      let next = null;
      for (const name of ['hands', 'face', 'pose']) {
        if (this.done[name] === this.frameId) continue;
        if (!next || this.done[name] < this.done[next]) next = name;
      }
      if (!next) break;
      if (ran && performance.now() - start + this.timings[next] > budgetMs) break;
      const ts = Math.max(this.lastTs + 1, Math.round(performance.now()));
      this.lastTs = ts;
      const t0 = performance.now();
      out[next] = this[next].detectForVideo(video, ts);
      this.timings[next] += (performance.now() - t0 - this.timings[next]) * 0.1;
      this.done[next] = this.frameId;
      ran = true;
    }
    this.timings.total = this.timings.face + this.timings.hands + this.timings.pose;
    return ran ? out : null;
  }
}
