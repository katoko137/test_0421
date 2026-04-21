const POSITION_LIMIT = 45;
const HANDLE_SIZE_MIN = 44;
const HANDLE_SIZE_MAX = 60;
const HANDLE_OFFSET_MIN = 20;
const HANDLE_OFFSET_MAX = 30;

const CONTROL_DEFS = [
  {
    key: "x",
    label: "位置X",
    min: -POSITION_LIMIT,
    max: POSITION_LIMIT,
    step: 0.5,
    format: (value) => `${value.toFixed(1)}%`,
  },
  {
    key: "y",
    label: "位置Y",
    min: -POSITION_LIMIT,
    max: POSITION_LIMIT,
    step: 0.5,
    format: (value) => `${value.toFixed(1)}%`,
  },
  {
    key: "size",
    label: "サイズ",
    min: 25,
    max: 200,
    step: 1,
    format: (value) => `${Math.round(value)}%`,
  },
  {
    key: "rotateX",
    label: "縦回転",
    min: -70,
    max: 70,
    step: 0.5,
    format: (value) => `${value.toFixed(1)}°`,
  },
  {
    key: "rotateY",
    label: "横回転",
    min: -70,
    max: 70,
    step: 0.5,
    format: (value) => `${value.toFixed(1)}°`,
  },
  {
    key: "rotateZ",
    label: "平面回転",
    min: -180,
    max: 180,
    step: 0.5,
    format: (value) => `${value.toFixed(1)}°`,
  },
  {
    key: "opacity",
    label: "不透明度",
    min: 10,
    max: 100,
    step: 1,
    format: (value) => `${Math.round(value)}%`,
  },
];

const CONTROL_BY_KEY = new Map(CONTROL_DEFS.map((control) => [control.key, control]));
const ROTATION_SENSITIVITY = Object.freeze({
  rotateX: 0.25,
  rotateY: 0.25,
  rotateZ: 0.4,
});

const elements = {
  stage: document.getElementById("preview-stage"),
  video: document.getElementById("camera-feed"),
  overlay: document.getElementById("overlay-layer"),
  overlayBody: document.getElementById("overlay-body"),
  overlayImage: document.getElementById("overlay-image"),
  rotationHandles: Array.from(document.querySelectorAll(".rotation-handle")),
  controlsPanel: document.getElementById("controls-panel"),
  mobileControlsToggle: document.getElementById("mobile-controls-toggle"),
  controlsList: document.getElementById("controls-list"),
  resetButton: document.getElementById("reset-button"),
  centerButton: document.getElementById("center-button"),
  retryButton: document.getElementById("retry-button"),
  runtimeNote: document.getElementById("runtime-note"),
  statusCard: document.getElementById("status-card"),
  statusTitle: document.getElementById("status-title"),
  statusDetail: document.getElementById("status-detail"),
};

const FALLBACK_STATE = Object.freeze({
  x: 0,
  y: 0,
  size: 100,
  rotateX: 0,
  rotateY: 0,
  rotateZ: 0,
  opacity: 100,
});

const overlayMeta = {
  aspectRatio: 1,
  ready: false,
  baseWidth: 0,
  baseHeight: 0,
};

const gestureState = {
  activePointers: new Map(),
  mode: "idle",
  dragPointerId: null,
  dragStartClientX: 0,
  dragStartClientY: 0,
  originX: 0,
  originY: 0,
  pinchStartDistance: 0,
  pinchStartSize: 100,
  suppressUntilAllReleased: false,
};

const rotationState = {
  active: false,
  pointerId: null,
  axis: null,
  dragAxis: null,
  startClientX: 0,
  startClientY: 0,
  startValue: 0,
  handle: null,
};

let defaultState = { ...FALLBACK_STATE };
let state = { ...FALLBACK_STATE };
let controlRefs = new Map();
let cameraStream = null;
let statusTimer = null;

document.addEventListener("DOMContentLoaded", async () => {
  bindControls();
  bindMobileControlsToggle();
  bindOverlayInteractions();
  updateRuntimeNote();
  showStatus("info", "準備中", "guide.png とカメラを初期化しています。");

  try {
    await loadOverlay();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "guide.png を読み込めませんでした。";
    showStatus("error", "ガイド画像の読み込みに失敗しました", message);
  }

  applyOverlayState();
  await initCamera();

  window.addEventListener("resize", handleViewportChange, { passive: true });
  window.addEventListener("orientationchange", handleViewportChange);
});

async function initCamera() {
  cleanupCamera();

  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraUnsupportedMessage();
    return;
  }

  showStatus("info", "カメラに接続しています", "背面カメラを優先して起動します。");

  const attempts = [
    {
      video: {
        facingMode: { ideal: "environment" },
      },
      audio: false,
    },
    {
      video: true,
      audio: false,
    },
  ];

  let lastError = null;

  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      cameraStream = stream;
      elements.video.srcObject = stream;
      await elements.video.play();
      showStatus(
        "info",
        "カメラ準備完了",
        "映像の上で赤枠ガイドを調整できます。",
        2200,
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }

  showCameraFailureMessage(lastError);
}

async function loadOverlay() {
  const sourceImage = await loadImage("guide.png");
  const processed = processGuideImage(sourceImage);

  overlayMeta.aspectRatio = processed.width / processed.height;
  overlayMeta.ready = true;
  elements.overlay.hidden = false;
  elements.overlayImage.src = processed.dataUrl;

  defaultState = createDefaultState();
  state = { ...defaultState };
  syncAllControls();
}

function bindMobileControlsToggle() {
  if (!elements.mobileControlsToggle) {
    return;
  }

  const syncToggleState = () => {
    const isCollapsed = document.body.classList.contains("mobile-controls-collapsed");

    elements.mobileControlsToggle.textContent = isCollapsed
      ? "Show sliders"
      : "Hide sliders";
    elements.mobileControlsToggle.setAttribute("aria-expanded", String(!isCollapsed));
  };

  elements.mobileControlsToggle.addEventListener("click", () => {
    document.body.classList.toggle("mobile-controls-collapsed");
    syncToggleState();
    window.requestAnimationFrame(handleViewportChange);
  });

  syncToggleState();
}

function bindControls() {
  elements.controlsList.innerHTML = CONTROL_DEFS.map((control) => {
    const { key, label, min, max, step } = control;

    return `
      <div class="control-card">
        <div class="control-top">
          <label class="control-label" for="control-${key}">${label}</label>
          <output class="control-value" id="value-${key}" for="control-${key}"></output>
        </div>
        <input
          id="control-${key}"
          name="${key}"
          type="range"
          min="${min}"
          max="${max}"
          step="${step}"
          value="${state[key]}"
        >
      </div>
    `;
  }).join("");

  CONTROL_DEFS.forEach((control) => {
    const input = document.getElementById(`control-${control.key}`);
    const output = document.getElementById(`value-${control.key}`);

    controlRefs.set(control.key, { input, output, format: control.format });

    input.addEventListener("input", () => {
      state[control.key] = Number(input.value);
      updateControlValue(control.key);
      applyOverlayState();
    });

    updateControlValue(control.key);
  });

  elements.resetButton.addEventListener("click", () => {
    state = { ...defaultState };
    syncAllControls();
    applyOverlayState();
  });

  elements.centerButton.addEventListener("click", () => {
    state.x = 0;
    state.y = 0;
    updateControlValue("x");
    updateControlValue("y");
    applyOverlayState();
  });

  elements.retryButton.addEventListener("click", async () => {
    await initCamera();
  });
}

function bindOverlayInteractions() {
  elements.overlayBody.addEventListener("pointerdown", handleOverlayBodyPointerDown);
  elements.overlayBody.addEventListener("pointermove", handleOverlayBodyPointerMove);
  elements.overlayBody.addEventListener("pointerup", handleOverlayBodyPointerEnd);
  elements.overlayBody.addEventListener("pointercancel", handleOverlayBodyPointerEnd);
  elements.overlayBody.addEventListener(
    "lostpointercapture",
    handleOverlayBodyPointerEnd,
  );

  elements.rotationHandles.forEach((handle) => {
    handle.addEventListener("pointerdown", handleRotationPointerDown);
    handle.addEventListener("pointermove", handleRotationPointerMove);
    handle.addEventListener("pointerup", handleRotationPointerEnd);
    handle.addEventListener("pointercancel", handleRotationPointerEnd);
    handle.addEventListener("lostpointercapture", handleRotationPointerEnd);
  });
}

function handleOverlayBodyPointerDown(event) {
  if (!overlayMeta.ready || rotationState.active) {
    return;
  }

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  event.preventDefault();
  elements.overlayBody.setPointerCapture(event.pointerId);
  setActivePointer(event);

  if (gestureState.suppressUntilAllReleased) {
    return;
  }

  if (gestureState.activePointers.size === 1) {
    startDragGesture(event.pointerId);
    return;
  }

  if (gestureState.activePointers.size >= 2) {
    startPinchGesture();
  }
}

function handleOverlayBodyPointerMove(event) {
  if (!gestureState.activePointers.has(event.pointerId)) {
    return;
  }

  event.preventDefault();
  setActivePointer(event);

  if (gestureState.suppressUntilAllReleased) {
    return;
  }

  if (gestureState.activePointers.size >= 2) {
    if (gestureState.mode !== "pinch") {
      startPinchGesture();
    }

    updatePinchGesture();
    return;
  }

  if (gestureState.mode === "drag" && gestureState.dragPointerId === event.pointerId) {
    updateDragGesture(event.pointerId);
  }
}

function handleOverlayBodyPointerEnd(event) {
  finalizeOverlayBodyPointer(event.pointerId);
}

function startDragGesture(pointerId) {
  const point = gestureState.activePointers.get(pointerId);

  if (!point) {
    return;
  }

  gestureState.mode = "drag";
  gestureState.dragPointerId = pointerId;
  gestureState.dragStartClientX = point.clientX;
  gestureState.dragStartClientY = point.clientY;
  gestureState.originX = state.x;
  gestureState.originY = state.y;
  elements.overlay.classList.add("is-dragging");
  elements.overlay.classList.remove("is-pinching");
}

function updateDragGesture(pointerId) {
  const point = gestureState.activePointers.get(pointerId);
  const stageRect = elements.stage.getBoundingClientRect();

  if (!point || !stageRect.width || !stageRect.height) {
    return;
  }

  const deltaX = point.clientX - gestureState.dragStartClientX;
  const deltaY = point.clientY - gestureState.dragStartClientY;
  const nextX = clamp(
    gestureState.originX + (deltaX / stageRect.width) * 100,
    -POSITION_LIMIT,
    POSITION_LIMIT,
  );
  const nextY = clamp(
    gestureState.originY + (deltaY / stageRect.height) * 100,
    -POSITION_LIMIT,
    POSITION_LIMIT,
  );

  state.x = roundTo(nextX, 1);
  state.y = roundTo(nextY, 1);
  updateControlValue("x");
  updateControlValue("y");
  applyOverlayState();
}

function startPinchGesture() {
  const points = getPrimaryGesturePoints();

  if (points.length < 2) {
    return;
  }

  gestureState.mode = "pinch";
  gestureState.dragPointerId = null;
  gestureState.pinchStartDistance = Math.max(
    getDistanceBetweenPoints(points[0], points[1]),
    1,
  );
  gestureState.pinchStartSize = state.size;
  elements.overlay.classList.remove("is-dragging");
  elements.overlay.classList.add("is-pinching");
}

function updatePinchGesture() {
  const points = getPrimaryGesturePoints();

  if (points.length < 2) {
    return;
  }

  const sizeControl = CONTROL_BY_KEY.get("size");
  const distance = Math.max(getDistanceBetweenPoints(points[0], points[1]), 1);
  const scale = distance / gestureState.pinchStartDistance;
  const nextSize = clamp(
    gestureState.pinchStartSize * scale,
    sizeControl.min,
    sizeControl.max,
  );

  state.size = roundTo(nextSize, 1);
  updateControlValue("size");
  applyOverlayState();
}

function finalizeOverlayBodyPointer(pointerId) {
  const hadPointer = gestureState.activePointers.delete(pointerId);

  if (
    !hadPointer &&
    gestureState.mode === "idle" &&
    !gestureState.suppressUntilAllReleased
  ) {
    return;
  }

  if (gestureState.mode === "pinch") {
    gestureState.mode = "idle";
    gestureState.dragPointerId = null;
    gestureState.pinchStartDistance = 0;
    elements.overlay.classList.remove("is-pinching");
    elements.overlay.classList.remove("is-dragging");
    gestureState.suppressUntilAllReleased = gestureState.activePointers.size > 0;
  } else if (gestureState.mode === "drag" && gestureState.dragPointerId === pointerId) {
    gestureState.mode = "idle";
    gestureState.dragPointerId = null;
    elements.overlay.classList.remove("is-dragging");
  }

  if (gestureState.activePointers.size === 0) {
    resetGestureState();
  }
}

function handleRotationPointerDown(event) {
  if (!overlayMeta.ready || gestureState.activePointers.size > 0 || rotationState.active) {
    return;
  }

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  const handle = event.currentTarget;
  const axis = handle.dataset.axis;
  const dragAxis = handle.dataset.dragAxis;

  if (!axis || !dragAxis) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  rotationState.active = true;
  rotationState.pointerId = event.pointerId;
  rotationState.axis = axis;
  rotationState.dragAxis = dragAxis;
  rotationState.startClientX = event.clientX;
  rotationState.startClientY = event.clientY;
  rotationState.startValue = state[axis];
  rotationState.handle = handle;

  handle.classList.add("is-active");
  elements.overlay.classList.add("is-rotating");
  handle.setPointerCapture(event.pointerId);
}

function handleRotationPointerMove(event) {
  if (!rotationState.active || rotationState.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const control = CONTROL_BY_KEY.get(rotationState.axis);
  const sensitivity = ROTATION_SENSITIVITY[rotationState.axis] ?? 0.25;
  const deltaPixels =
    rotationState.dragAxis === "x"
      ? event.clientX - rotationState.startClientX
      : rotationState.startClientY - event.clientY;
  const nextValue = clamp(
    rotationState.startValue + deltaPixels * sensitivity,
    control.min,
    control.max,
  );

  state[rotationState.axis] = roundTo(nextValue, 1);
  updateControlValue(rotationState.axis);
  applyOverlayState();
}

function handleRotationPointerEnd(event) {
  if (!rotationState.active || rotationState.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (rotationState.handle) {
    rotationState.handle.classList.remove("is-active");
  }

  elements.overlay.classList.remove("is-rotating");
  rotationState.active = false;
  rotationState.pointerId = null;
  rotationState.axis = null;
  rotationState.dragAxis = null;
  rotationState.startClientX = 0;
  rotationState.startClientY = 0;
  rotationState.startValue = 0;
  rotationState.handle = null;
}

function applyOverlayState() {
  if (!overlayMeta.ready || !elements.stage) {
    return;
  }

  if (!overlayMeta.baseWidth || !overlayMeta.baseHeight) {
    updateBaseOverlayMetrics();
  }

  const stageRect = elements.stage.getBoundingClientRect();

  if (
    !stageRect.width ||
    !stageRect.height ||
    !overlayMeta.baseWidth ||
    !overlayMeta.baseHeight
  ) {
    return;
  }

  const widthPx = overlayMeta.baseWidth * (state.size / 100);
  const heightPx = widthPx / overlayMeta.aspectRatio;
  const xPx = (state.x / 100) * stageRect.width;
  const yPx = (state.y / 100) * stageRect.height;
  const handleSize = clamp(widthPx * 0.18, HANDLE_SIZE_MIN, HANDLE_SIZE_MAX);
  const handleOffset = clamp(handleSize * 0.48, HANDLE_OFFSET_MIN, HANDLE_OFFSET_MAX);

  elements.overlay.style.width = `${widthPx}px`;
  elements.overlay.style.height = `${heightPx}px`;
  elements.overlay.style.opacity = `${state.opacity / 100}`;
  elements.overlay.style.setProperty("--handle-size", `${roundTo(handleSize, 1)}px`);
  elements.overlay.style.setProperty("--handle-offset", `${roundTo(handleOffset, 1)}px`);
  elements.overlay.style.transform = [
    `translate3d(${(xPx - widthPx / 2).toFixed(2)}px, ${(yPx - heightPx / 2).toFixed(2)}px, 0)`,
    "perspective(1000px)",
    `rotateX(${state.rotateX}deg)`,
    `rotateY(${state.rotateY}deg)`,
    `rotateZ(${state.rotateZ}deg)`,
  ].join(" ");

  elements.rotationHandles.forEach((handle) => {
    const control = CONTROL_BY_KEY.get(handle.dataset.axis);

    if (!control) {
      return;
    }

    handle.title = `${control.label}: ${control.format(state[control.key])}`;
  });
}

function showStatus(tone, title, detail, autoHideMs = 0) {
  clearTimeout(statusTimer);
  elements.statusCard.hidden = false;
  elements.statusCard.dataset.tone = tone;
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;

  if (autoHideMs > 0) {
    statusTimer = window.setTimeout(() => {
      elements.statusCard.hidden = true;
    }, autoHideMs);
  }
}

function handleViewportChange() {
  if (overlayMeta.ready) {
    updateBaseOverlayMetrics();
    defaultState = createDefaultState();
  }

  applyOverlayState();
}

function createDefaultState() {
  updateBaseOverlayMetrics();
  return { ...FALLBACK_STATE };
}

function updateBaseOverlayMetrics() {
  const stageRect = elements.stage.getBoundingClientRect();

  if (!stageRect.width || !stageRect.height || !overlayMeta.aspectRatio) {
    overlayMeta.baseWidth = 0;
    overlayMeta.baseHeight = 0;
    return;
  }

  const baseWidth = Math.min(
    stageRect.width * 0.38,
    stageRect.height * 0.72 * overlayMeta.aspectRatio,
  );

  overlayMeta.baseWidth = baseWidth;
  overlayMeta.baseHeight = baseWidth / overlayMeta.aspectRatio;
}

function updateRuntimeNote() {
  if (location.protocol === "file:") {
    elements.runtimeNote.textContent =
      "現在はファイルを直接開いています。ブラウザによってはカメラ制約があるため、映像が出ない場合はこのフォルダで localhost 配信に切り替えると安定します。";
    return;
  }

  elements.runtimeNote.textContent =
    "このページはブラウザのカメラ権限を利用します。背面カメラが取れない場合は通常カメラへ自動で切り替えます。";
}

function updateControlValue(key) {
  const refs = controlRefs.get(key);

  if (!refs) {
    return;
  }

  refs.input.value = `${state[key]}`;
  refs.output.value = refs.format(state[key]);
  refs.output.textContent = refs.format(state[key]);
}

function syncAllControls() {
  CONTROL_DEFS.forEach((control) => {
    updateControlValue(control.key);
  });
}

function showCameraUnsupportedMessage() {
  let detail =
    "このブラウザでは `navigator.mediaDevices.getUserMedia()` が利用できません。";

  if (location.protocol === "file:") {
    detail +=
      " 直接起動で制約が出る場合は、このフォルダで `python -m http.server 8000` を実行し、`http://localhost:8000` から開いてください。";
  } else if (!window.isSecureContext) {
    detail += " `http://localhost` か `https://` で開くと動作しやすくなります。";
  }

  showStatus("warning", "カメラAPIを利用できません", detail);
}

function showCameraFailureMessage(error) {
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  const message = getCameraErrorDetail(name);
  showStatus("error", "カメラを開始できませんでした", message);
}

function getCameraErrorDetail(name) {
  const localhostHint =
    " 直接起動で制約が出る場合は、このフォルダで `python -m http.server 8000` を実行し、`http://localhost:8000` から開く方法を試してください。";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return (
        "ブラウザのカメラ権限が許可されていないか、安全な実行環境として扱われていません。アドレスバー付近の権限設定を確認してください。" +
        (location.protocol === "file:" || !window.isSecureContext ? localhostHint : "")
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "利用可能なカメラが見つかりませんでした。接続状態とOS側の認識を確認してください。";
    case "NotReadableError":
    case "TrackStartError":
      return "別のアプリがカメラを使用中の可能性があります。不要なアプリを閉じて再試行してください。";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "背面カメラ条件が合わなかったため通常カメラへ切り替えましたが、利用可能な映像入力を開始できませんでした。";
    default:
      return (
        "カメラ初期化に失敗しました。権限設定、接続状態、または起動方法を確認してから再試行してください。" +
        (location.protocol === "file:" ? localhostHint : "")
      );
  }
}

function cleanupCamera() {
  if (!cameraStream) {
    return;
  }

  cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  elements.video.srcObject = null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error(`${src} の読み込みに失敗しました。配置場所を確認してください。`)),
      { once: true },
    );

    image.src = src;
  });
}

function processGuideImage(image) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("ガイド画像処理用の canvas を初期化できませんでした。");
  }

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  context.drawImage(image, 0, 0);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let hasVisiblePixels = false;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];

    if (!alpha) {
      continue;
    }

    if (red >= 245 && green >= 245 && blue >= 245) {
      data[index + 3] = 0;
      continue;
    }

    const pixel = index / 4;
    const x = pixel % width;
    const y = Math.floor(pixel / width);

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    hasVisiblePixels = true;
  }

  if (!hasVisiblePixels) {
    throw new Error("guide.png から赤枠部分を検出できませんでした。");
  }

  context.putImageData(imageData, 0, 0);

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const croppedCanvas = document.createElement("canvas");
  const croppedContext = croppedCanvas.getContext("2d");

  if (!croppedContext) {
    throw new Error("切り抜き用の canvas を初期化できませんでした。");
  }

  croppedCanvas.width = cropWidth;
  croppedCanvas.height = cropHeight;
  croppedContext.drawImage(
    canvas,
    minX,
    minY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  );

  return {
    width: cropWidth,
    height: cropHeight,
    dataUrl: croppedCanvas.toDataURL("image/png"),
  };
}

function setActivePointer(event) {
  gestureState.activePointers.set(event.pointerId, {
    clientX: event.clientX,
    clientY: event.clientY,
  });
}

function getPrimaryGesturePoints() {
  return Array.from(gestureState.activePointers.values()).slice(0, 2);
}

function getDistanceBetweenPoints(pointA, pointB) {
  return Math.hypot(pointB.clientX - pointA.clientX, pointB.clientY - pointA.clientY);
}

function resetGestureState() {
  gestureState.activePointers.clear();
  gestureState.mode = "idle";
  gestureState.dragPointerId = null;
  gestureState.dragStartClientX = 0;
  gestureState.dragStartClientY = 0;
  gestureState.originX = 0;
  gestureState.originY = 0;
  gestureState.pinchStartDistance = 0;
  gestureState.pinchStartSize = state.size;
  gestureState.suppressUntilAllReleased = false;
  elements.overlay.classList.remove("is-dragging", "is-pinching");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
