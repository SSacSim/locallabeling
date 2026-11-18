const byId = (id) => document.getElementById(id);
const dialog = byId("extractionDialog");
const form = byId("extractionForm");
const source = byId("extractionSource");
const output = byId("extractionOutput");
const videos = byId("extractionVideos");
const selectAll = byId("selectAllVideos");
const browser = byId("extractionBrowser");
const directories = byId("extractionDirectories");
const message = byId("extractionMessage");
const status = byId("extractionStatus");
let requestJson;
let labelEditor;
let onStarted;
let loadedPath = "";
let listRequest = 0;
let browseRequest = 0;
let browseTarget = "";
let currentPath = "";
let parentPath = "";
let pollTimer;
let session = 0;

function resetVideos(text) {
  listRequest++;
  loadedPath = "";
  videos.textContent = text;
  selectAll.disabled = true;
  selectAll.checked = selectAll.indeterminate = false;
}

async function listVideos() {
  const path = source.value.trim();
  resetVideos(path ? "영상을 불러오는 중…" : "영상 폴더를 입력하세요.");
  if (!path) return;
  const id = listRequest;
  message.textContent = "";
  try {
    const data = await requestJson("/api/admin/extraction/videos?path=" + encodeURIComponent(path));
    if (id !== listRequest) return;
    loadedPath = source.value = data.path;
    videos.textContent = data.videos.length ? "" : "이 폴더에 영상 파일이 없습니다.";
    selectAll.disabled = !data.videos.length;
    for (const name of data.videos) {
      const label = document.createElement("label");
      label.className = "check-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = name;
      label.append(input, document.createTextNode(name));
      videos.append(label);
    }
  } catch (error) {
    if (id === listRequest) {
      videos.textContent = "영상 목록을 불러오지 못했습니다.";
      message.textContent = error.message;
    }
  }
}

async function browse(path) {
  const id = ++browseRequest;
  browser.hidden = false;
  message.textContent = "";
  byId("extractionBrowsePath").textContent = path || "서버 드라이브";
  directories.textContent = "폴더를 불러오는 중…";
  currentPath = parentPath = "";
  byId("extractionChoose").disabled = true;
  byId("extractionUp").disabled = !path;
  try {
    const data = await requestJson("/api/admin/folders/browse?include_yolo_info=false&path=" + encodeURIComponent(path));
    if (id !== browseRequest) return;
    currentPath = data.current_path;
    parentPath = data.parent_path;
    byId("extractionChoose").disabled = !currentPath;
    byId("extractionBrowsePath").textContent = currentPath || "서버 드라이브";
    directories.textContent = data.entries.length ? "" : "하위 폴더가 없습니다.";
    for (const entry of data.entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folder-open";
      button.textContent = entry.name;
      button.addEventListener("click", () => browse(entry.path));
      directories.append(button);
    }
  } catch (error) {
    if (id === browseRequest) directories.textContent = error.message;
  }
}

function closeBrowser() {
  browseRequest++;
  browser.hidden = true;
}

function lockForm(locked) {
  byId("extractionFields").disabled = locked;
  byId("startExtractionButton").disabled = locked;
}

function showJob(job) {
  const running = job.status === "running";
  lockForm(running);
  if (running) {
    status.textContent = job.video + " 추출 중 · " + job.images + "장 · " + job.folders + "개 폴더";
    pollTimer = setTimeout(() => readStatus(session), 1000);
  } else if (job.status === "done") {
    status.textContent = "추출 완료 · " + job.images + "장 · " + job.folders + "개 폴더 · " + job.output_path;
  } else if (job.status === "failed") {
    status.textContent = "추출 실패 · " + job.error;
  } else {
    status.textContent = "";
  }
}

async function readStatus(id) {
  try {
    const job = await requestJson("/api/admin/extraction");
    if (id === session) showJob(job);
  } catch (error) {
    if (id === session) {
      status.textContent = "추출 상태를 확인할 수 없습니다. " + error.message;
      pollTimer = setTimeout(() => readStatus(id), 3000);
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (byId("startExtractionButton").disabled) return;
  const selected = Array.from(videos.querySelectorAll("input:checked"), (box) => box.value);
  const fps = byId("extractionFps").valueAsNumber;
  const name = byId("extractionProjectName").value.trim();
  const labels = labelEditor.values();
  if (!name || !labels.length) {
    message.textContent = name ? "라벨을 하나 이상 추가하세요." : "프로젝트 이름을 입력하세요.";
    return;
  }
  if (source.value.trim() !== loadedPath || !selected.length) {
    message.textContent = "영상 목록에서 추출할 파일을 선택하세요.";
    return;
  }
  if (!(fps > 0 && Number.isFinite(fps))) {
    message.textContent = "FPS는 0보다 큰 숫자로 입력하세요.";
    return;
  }
  const id = session;
  const started = onStarted;
  closeBrowser();
  lockForm(true);
  message.textContent = "";
  status.textContent = "추출을 시작하는 중…";
  try {
    const job = await requestJson("/api/admin/extraction", {
      method: "POST",
      body: { name, labels, source_path: loadedPath, videos: selected, output_path: output.value.trim(),
        fps, max_images: byId("extractionLimit").valueAsNumber }
    });
    if (job.project) {
      if (id === session) dialog.close();
      started(job.project);
    } else if (id === session) {
      showJob(job);
    }
  } catch (error) {
    if (id === session) {
      message.textContent = error.message;
      await readStatus(id);
    }
  }
});

source.addEventListener("input", () => resetVideos("영상 불러오기를 눌러 목록을 확인하세요."));
source.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    listVideos();
  }
});
byId("listVideosButton").addEventListener("click", listVideos);
selectAll.addEventListener("change", () => {
  videos.querySelectorAll("input").forEach((box) => { box.checked = selectAll.checked; });
});
videos.addEventListener("change", () => {
  const total = videos.querySelectorAll("input").length;
  const count = videos.querySelectorAll("input:checked").length;
  selectAll.checked = count === total;
  selectAll.indeterminate = count > 0 && count < total;
});
dialog.querySelectorAll("[data-extraction-browse]").forEach((button) => {
  button.addEventListener("click", () => {
    browseTarget = button.dataset.extractionBrowse;
    browse((browseTarget === "source" ? source : output).value.trim());
  });
});
byId("extractionUp").addEventListener("click", () => browse(parentPath));
byId("extractionChoose").addEventListener("click", () => {
  closeBrowser();
  if (browseTarget === "source") {
    source.value = currentPath;
    listVideos();
  } else {
    output.value = currentPath;
  }
});
byId("extractionBrowseClose").addEventListener("click", closeBrowser);
byId("closeExtractionButton").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  session++;
  listRequest++;
  closeBrowser();
  clearTimeout(pollTimer);
});

export function openExtractionDialog(request, editor, started) {
  if (dialog.open) return;
  requestJson = request;
  labelEditor = editor;
  onStarted = started;
  form.reset();
  labelEditor.reset();
  resetVideos("영상 폴더를 선택하세요.");
  message.textContent = "";
  status.textContent = "추출 상태를 확인하는 중…";
  lockForm(true);
  dialog.showModal();
  readStatus(++session);
}
