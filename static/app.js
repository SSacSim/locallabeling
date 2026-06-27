(function () {
  "use strict";

  var TOKEN_KEY = "custom_labeling_token";
  var CLAIM_KEY = "custom_labeling_claim";
  var IMAGE_PRELOAD_FORWARD_COUNT = 20;
  var IMAGE_PRELOAD_BACKWARD_COUNT = 20;
  var IMAGE_PRELOAD_CACHE_LIMIT = 45;
  var DEFAULT_LABEL_COLORS = [
    "#1f77b4",
    "#ff7f0e",
    "#2ca02c",
    "#d62728",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#7f7f7f",
    "#bcbd22",
    "#17becf",
    "#393b79",
    "#637939"
  ];

  var state = {
    token: "",
    user: null,
    claim: null,
    stats: null,
    images: [],
    allImages: [],
    currentImageIndex: -1,
    annotations: [],
    annotationsDirty: false,
    drawMode: false,
    drawingBox: null,
    pendingBox: null,
    selectedAnnotationIndex: -1,
    editingAnnotationIndex: -1,
    boxInteraction: null,
    lastAnnotationClick: { index: -1, at: 0 },
    imageView: { scale: 1, offsetX: 0, offsetY: 0, panning: null },
    imageLoad: { requestId: 0, imageReady: false, annotationsReady: false },
    activeFolder: { projectId: "", folderId: "" },
    startAtCheckpoint: false,
    initialCheckpointApplied: false,
    annotationClipboard: [],
    annotationRequestId: 0,
    imagePreloadTimer: 0,
    imagePreloads: {},
    imagePreloadOrder: [],
    worker: { projects: [] },
    admin: { users: [], projects: [] },
    adminActiveTab: "projects",
    editingProjectId: "",
    projectLabels: defaultProjectLabels(),
    folderBrowser: { currentPath: "", parentPath: "", entries: [], selectedFolders: [] },
    busy: false
  };

  var els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindElements();
    attachEvents();
    state.token = localStorage.getItem(TOKEN_KEY) || "";
    state.claim = getStoredClaim();
    if (state.token) {
      restoreSession();
    } else {
      renderAuth();
    }
  }

  function bindElements() {
    [
      "loginPanel", "appPanel", "workerPanel", "loginUsernameInput", "loginPasswordInput", "loginButton", "loginMessage",
      "currentUserSummary", "logoutButton", "claimButton", "saveButton", "releaseButton", "refreshButton",
      "refreshImagesButton", "claimSummary", "projectSummary", "expiresSummary", "statusMessage", "checkpointSummary",
      "emptyState", "imageLoadingState", "imageStage", "claimedImage", "filenameSummary", "imageStatusSummary", "labelInput", "quickLabels",
      "notesInput", "statsGrid", "listSummary", "imageListBody", "prevImageButton", "nextImageButton",
      "drawBoxButton", "saveAnnotationsButton", "annotationOverlay", "boxLabelPicker", "boxLabelList",
      "cancelBoxLabelButton", "annotationList", "currentImageCounter",
      "workerKeyboardHint", "openFolderPickerButton", "toolbarFolderMarkSelect", "folderPickerModal", "closeFolderPickerButton",
      "assignedFolderList", "adminPanel", "adminRefreshButton",
      "adminProjectsTab", "adminWorkersTab", "adminAssignmentsTab", "adminProgressTab",
      "adminProjectsView", "adminWorkersView", "adminAssignmentsView", "adminProgressView",
      "adminViewTitle", "adminViewDescription", "openProjectModalButton",
      "projectModal", "projectModalTitle", "projectModalDescription", "closeProjectModalButton", "cancelProjectModalButton", "projectNameInput",
      "projectLabelsInput", "projectLabelNameInput", "projectLabelColorInput", "addProjectLabelButton", "projectLabelList",
      "createProjectButton", "folderPathInput", "browseFolderPathButton",
      "folderUpButton", "selectCurrentFolderButton", "folderCurrentPath", "folderBrowserList", "selectedFolderList",
      "clearSelectedFoldersButton", "newUsernameInput", "newPasswordInput", "newRoleSelect",
      "createUserButton", "assignmentUserSelect", "assignmentProjectSelect", "assignmentFolderChecklist",
      "saveAssignmentButton", "createTempUserButton", "tempCredentialOutput",
      "projectList", "progressProjectSelect", "progressSummaryGrid", "progressFolderBody", "workerListBody", "userAssignmentBody"
    ].forEach(function (id) {
      els[id] = document.getElementById(id);
    });
  }

  function attachEvents() {
    els.loginButton.addEventListener("click", login);
    els.loginPasswordInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        login();
      }
    });
    els.logoutButton.addEventListener("click", logout);
    els.claimButton.addEventListener("click", function () { openWorkerFolder("", ""); });
    els.openFolderPickerButton.addEventListener("click", openFolderPicker);
    els.toolbarFolderMarkSelect.addEventListener("change", function () {
      var activeFolder = activeAssignedFolder();
      if (!activeFolder) {
        els.toolbarFolderMarkSelect.value = "working";
        setStatus("먼저 작업 폴더를 선택하세요.", "error");
        return;
      }
      setWorkerFolderMark(activeFolder.projectId, activeFolder.folderId, els.toolbarFolderMarkSelect.value, { reopenPicker: false });
    });
    els.closeFolderPickerButton.addEventListener("click", closeFolderPicker);
    els.saveButton.addEventListener("click", saveLabel);
    els.releaseButton.addEventListener("click", releaseClaim);
    els.refreshButton.addEventListener("click", refreshAll);
    els.refreshImagesButton.addEventListener("click", refreshImages);
    els.prevImageButton.addEventListener("click", function () { goToImage(state.currentImageIndex - 1); });
    els.nextImageButton.addEventListener("click", function () { goToImage(state.currentImageIndex + 1); });
    els.drawBoxButton.addEventListener("click", toggleDrawMode);
    els.saveAnnotationsButton.addEventListener("click", saveAnnotations);
    els.cancelBoxLabelButton.addEventListener("click", cancelPendingBox);
    els.boxLabelList.addEventListener("click", function (event) {
      var button = event.target.closest("[data-box-label-id]");
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        confirmPendingBox(parseInt(button.dataset.boxLabelId, 10));
      }
    });
    els.claimedImage.addEventListener("load", handleClaimedImageLoad);
    els.claimedImage.addEventListener("error", handleClaimedImageError);
    els.imageStage.addEventListener("wheel", handleStageWheel, { passive: false });
    els.imageStage.addEventListener("pointerdown", beginBoxDraw);
    els.imageStage.addEventListener("pointermove", updateBoxDraw);
    els.imageStage.addEventListener("pointerup", endBoxDraw);
    els.imageStage.addEventListener("pointercancel", cancelBoxDraw);
    window.addEventListener("resize", handleStageResize);
    document.addEventListener("keydown", handleWorkerKeydown);
    els.adminRefreshButton.addEventListener("click", refreshAdmin);
    [els.adminProjectsTab, els.adminWorkersTab, els.adminAssignmentsTab, els.adminProgressTab].forEach(function (button) {
      button.addEventListener("click", function () {
        state.adminActiveTab = button.dataset.adminTab;
        renderAdminTabs();
      });
    });
    els.progressProjectSelect.addEventListener("change", renderProgressView);
    els.openProjectModalButton.addEventListener("click", openProjectModal);
    els.closeProjectModalButton.addEventListener("click", closeProjectModal);
    els.cancelProjectModalButton.addEventListener("click", closeProjectModal);
    els.browseFolderPathButton.addEventListener("click", function () {
      browseFolders(els.folderPathInput.value.trim());
    });
    els.folderPathInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        browseFolders(els.folderPathInput.value.trim());
      }
    });
    els.folderUpButton.addEventListener("click", function () {
      browseFolders(state.folderBrowser.parentPath || "");
    });
    els.selectCurrentFolderButton.addEventListener("click", function () {
      addSelectedFolder(state.folderBrowser.currentPath);
    });
    els.clearSelectedFoldersButton.addEventListener("click", function () {
      state.folderBrowser.selectedFolders = [];
      renderSelectedFolders();
    });
    els.addProjectLabelButton.addEventListener("click", addProjectLabel);
    els.projectLabelNameInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        addProjectLabel();
      }
    });
    els.createUserButton.addEventListener("click", createUser);
    els.createTempUserButton.addEventListener("click", createTempUser);
    els.createProjectButton.addEventListener("click", saveProjectFromModal);
    els.saveAssignmentButton.addEventListener("click", saveFolderAssignments);
    els.assignmentUserSelect.addEventListener("change", renderAssignmentChecklist);
    els.assignmentProjectSelect.addEventListener("change", renderAssignmentChecklist);
    els.assignmentFolderChecklist.addEventListener("click", function (event) {
      var selectAllButton = event.target.closest("[data-assignment-select-all]");
      var clearAllButton = event.target.closest("[data-assignment-clear-all]");
      if (selectAllButton || clearAllButton) {
        setAssignmentChecklistChecked(Boolean(selectAllButton));
      }
    });
    els.assignedFolderList.addEventListener("click", function (event) {
      var markButton = event.target.closest("[data-folder-mark]");
      if (markButton) {
        setWorkerFolderMark(markButton.dataset.projectId, markButton.dataset.folderId, markButton.dataset.folderMark);
        return;
      }
      var button = event.target.closest("[data-open-folder]");
      if (button) {
        openWorkerFolder(button.dataset.projectId, button.dataset.folderId);
      }
    });
    els.labelInput.addEventListener("change", renderQuickLabels);

    els.quickLabels.addEventListener("click", function (event) {
      var button = event.target.closest("[data-label-id]");
      if (!button) {
        return;
      }
      els.labelInput.value = button.dataset.labelId;
      renderQuickLabels();
    });

    els.projectList.addEventListener("click", function (event) {
      var removeProject = event.target.closest("[data-remove-project]");
      var removeFolder = event.target.closest("[data-remove-folder]");
      var editProject = event.target.closest("[data-edit-project]");
      if (removeProject) {
        removeProjectById(removeProject.dataset.removeProject);
      } else if (editProject) {
        openProjectEditModal(editProject.dataset.editProject);
      } else if (removeFolder) {
        removeFolderById(removeFolder.dataset.projectId, removeFolder.dataset.removeFolder);
      }
    });

    els.workerListBody.addEventListener("click", function (event) {
      var activeButton = event.target.closest("[data-user-active]");
      var removeButton = event.target.closest("[data-remove-user]");
      if (activeButton) {
        setUserActive(activeButton.dataset.username, activeButton.dataset.userActive === "true");
      } else if (removeButton) {
        removeUser(removeButton.dataset.removeUser);
      }
    });

    els.folderBrowserList.addEventListener("click", function (event) {
      var openButton = event.target.closest("[data-open-folder]");
      var selectButton = event.target.closest("[data-select-folder]");
      if (openButton) {
        browseFolders(openButton.dataset.openFolder);
      } else if (selectButton) {
        addSelectedFolder(selectButton.dataset.selectFolder);
      }
    });

    els.selectedFolderList.addEventListener("click", function (event) {
      var removeButton = event.target.closest("[data-remove-selected-folder]");
      if (removeButton) {
        removeSelectedFolder(removeButton.dataset.removeSelectedFolder);
      }
    });

    els.projectLabelList.addEventListener("click", function (event) {
      var removeButton = event.target.closest("[data-remove-project-label]");
      if (removeButton) {
        removeProjectLabel(parseInt(removeButton.dataset.removeProjectLabel, 10));
      }
    });
    els.projectLabelList.addEventListener("input", function (event) {
      var colorInput = event.target.closest("[data-project-label-color]");
      if (colorInput) {
        updateProjectLabelColor(parseInt(colorInput.dataset.projectLabelColor, 10), colorInput.value);
      }
    });

    els.annotationList.addEventListener("click", function (event) {
      var removeButton = event.target.closest("[data-remove-annotation]");
      if (removeButton) {
        removeAnnotation(parseInt(removeButton.dataset.removeAnnotation, 10));
        return;
      }
      var row = event.target.closest("[data-select-annotation]");
      if (row) {
        selectAnnotation(parseInt(row.dataset.selectAnnotation, 10));
      }
    });
  }

  async function restoreSession() {
    try {
      var data = await requestJson("/api/auth/me");
      state.user = data.user;
      renderAuth();
      await refreshAll();
    } catch (error) {
      state.token = "";
      clearImagePreloads();
      localStorage.removeItem(TOKEN_KEY);
      renderAuth();
      setLoginMessage(error.message);
    }
  }

  async function login() {
    var username = els.loginUsernameInput.value.trim();
    var password = els.loginPasswordInput.value;
    if (!username || !password) {
      setLoginMessage("아이디와 비밀번호를 입력하세요.");
      return;
    }
    try {
      var data = await requestJson("/api/auth/login", {
        method: "POST",
        body: { username: username, password: password },
        skipAuth: true
      });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem(TOKEN_KEY, state.token);
      setLoginMessage("");
      renderAuth();
      await refreshAll();
    } catch (error) {
      setLoginMessage(error.message);
    }
  }

  async function logout() {
    try {
      await requestJson("/api/auth/logout", { method: "POST" });
    } catch (error) {
      // Local logout should still proceed when the server session is already gone.
    }
    state.token = "";
    state.user = null;
    state.claim = null;
    state.images = [];
    state.allImages = [];
    state.currentImageIndex = -1;
    state.activeFolder = { projectId: "", folderId: "" };
    state.startAtCheckpoint = false;
    state.initialCheckpointApplied = false;
    clearImagePreloads();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CLAIM_KEY);
    renderAuth();
  }

  async function refreshAll() {
    if (!state.user) {
      return;
    }
    if (state.user.role === "admin") {
      await refreshAdmin();
      return;
    }
    await refreshWorker();
  }

  async function refreshWorker() {
    var data = await requestJson("/api/worker/config");
    state.worker = { projects: Array.isArray(data.projects) ? data.projects : [] };
    if (!state.initialCheckpointApplied) {
      var latest = latestWorkerCheckpoint();
      if (latest) {
        state.activeFolder = { projectId: latest.projectId, folderId: latest.folderId };
        state.startAtCheckpoint = true;
      }
      state.initialCheckpointApplied = true;
    }
    renderAssignedFolders();
    await refreshImages();
  }

  async function refreshAdmin() {
    if (!state.user || state.user.role !== "admin") {
      return;
    }
    try {
      var data = await requestJson("/api/admin/config");
      state.admin = {
        users: Array.isArray(data.users) ? data.users : [],
        projects: Array.isArray(data.projects) ? data.projects : []
      };
      renderAdmin();
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function refreshStats() {
    try {
      state.stats = await requestJson("/api/stats");
      renderStats();
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function refreshImages() {
    try {
      var data = await requestJson("/api/images");
      var previousCurrent = currentImage();
      state.allImages = Array.isArray(data.images) ? data.images : [];
      state.images = imagesForActiveFolder(state.allImages);
      renderImages();
      if (state.user && state.user.role !== "admin") {
        if (state.startAtCheckpoint) {
          state.currentImageIndex = checkpointImageIndex(state.images);
          state.startAtCheckpoint = false;
        } else {
          var preferredId = state.claim && state.claim.image ? state.claim.image.id : (previousCurrent ? previousCurrent.id : "");
          if (preferredId) {
            var nextIndex = state.images.findIndex(function (image) { return image.id === preferredId; });
            state.currentImageIndex = nextIndex >= 0 ? nextIndex : 0;
          } else {
            state.currentImageIndex = firstAvailableImageIndex(state.images);
          }
        }
        await loadCurrentImage();
      }
    } catch (error) {
      els.imageListBody.innerHTML = '<tr><td colspan="4" class="table-empty">이미지 목록을 불러오지 못했습니다.</td></tr>';
      setStatus(error.message, "error");
    }
  }

  function imagesForActiveFolder(images) {
    if (!state.activeFolder.folderId) {
      return images.slice();
    }
    return images.filter(function (image) {
      return image.project_id === state.activeFolder.projectId && image.folder_id === state.activeFolder.folderId;
    });
  }

  function firstAvailableImageIndex(images) {
    if (!images.length) {
      return -1;
    }
    var availableIndex = images.findIndex(function (image) {
      return image.status === "available";
    });
    if (availableIndex >= 0) {
      return availableIndex;
    }
    var unlabeledIndex = images.findIndex(function (image) {
      return !image.labeled;
    });
    return unlabeledIndex >= 0 ? unlabeledIndex : 0;
  }

  function checkpointImageIndex(images) {
    if (!images.length) {
      return -1;
    }
    var checkpoint = activeFolderCheckpoint();
    if (checkpoint && checkpoint.rel_path) {
      var checkpointIndex = images.findIndex(function (image) {
        return image.relative_path === checkpoint.rel_path &&
          (!state.activeFolder.projectId || image.project_id === state.activeFolder.projectId) &&
          (!state.activeFolder.folderId || image.folder_id === state.activeFolder.folderId);
      });
      if (checkpointIndex >= 0) {
        return checkpointIndex;
      }
    }
    return firstAvailableImageIndex(images);
  }

  function latestWorkerCheckpoint() {
    var latest = null;
    assignedWorkerFolders().forEach(function (folder) {
      var checkpoint = folder.workerCheckpoint || {};
      if (!checkpoint.rel_path) {
        return;
      }
      var updatedAt = checkpoint.updated_at || "";
      if (!latest || updatedAt > latest.updatedAt) {
        latest = {
          projectId: folder.projectId,
          folderId: folder.folderId,
          updatedAt: updatedAt
        };
      }
    });
    return latest;
  }

  function activeFolderCheckpoint() {
    var folders = assignedWorkerFolders();
    if (state.activeFolder.folderId) {
      var active = folders.find(function (folder) {
        return folder.projectId === state.activeFolder.projectId && folder.folderId === state.activeFolder.folderId;
      });
      return active ? active.workerCheckpoint : null;
    }
    var latest = latestWorkerCheckpoint();
    if (!latest) {
      return null;
    }
    var folder = folders.find(function (item) {
      return item.projectId === latest.projectId && item.folderId === latest.folderId;
    });
    return folder ? folder.workerCheckpoint : null;
  }

  function currentImage() {
    if (state.currentImageIndex < 0 || state.currentImageIndex >= state.images.length) {
      return null;
    }
    return state.images[state.currentImageIndex];
  }

  function defaultLabelColor(index) {
    var safeIndex = Math.abs(Number(index) || 0);
    return DEFAULT_LABEL_COLORS[safeIndex % DEFAULT_LABEL_COLORS.length];
  }

  function normalizeLabelColor(value, index) {
    var color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : defaultLabelColor(index);
  }

  function defaultProjectLabels() {
    return ["person", "car", "defect"].map(function (name, index) {
      return { id: index, name: name, color: defaultLabelColor(index) };
    });
  }

  function nextAvailableLabelColor(labels) {
    var used = {};
    (labels || []).forEach(function (label, index) {
      used[normalizeProjectLabel(label, index).color] = true;
    });
    for (var i = 0; i < DEFAULT_LABEL_COLORS.length; i += 1) {
      if (!used[DEFAULT_LABEL_COLORS[i]]) {
        return DEFAULT_LABEL_COLORS[i];
      }
    }
    return defaultLabelColor((labels || []).length);
  }

  function normalizeProjectLabel(label, index) {
    var id = index;
    var name = "";
    var color = "";
    if (label && typeof label === "object") {
      if (!Number.isNaN(Number(label.id))) {
        id = Number(label.id);
      }
      name = String(label.name || "").trim();
      color = label.color;
    } else {
      name = String(label || "").trim();
    }
    return { id: id, name: name, color: normalizeLabelColor(color, index) };
  }

  function serializeProjectLabels() {
    return state.projectLabels.map(function (label, index) {
      return normalizeProjectLabel(label, index);
    }).filter(function (label) {
      return label.name;
    }).map(function (label) {
      return { name: label.name, color: label.color };
    });
  }

  function labelsForImage(image) {
    if (!image) {
      return [];
    }
    var project = (state.worker.projects || []).find(function (item) {
      return item.id === image.project_id;
    });
    return project && Array.isArray(project.labels) ? project.labels.map(normalizeProjectLabel).filter(function (label) { return label.name; }) : [];
  }

  async function goToImage(index) {
    if (!state.images.length) {
      return;
    }
    if (state.busy) {
      return;
    }
    var nextIndex = Math.max(0, Math.min(index, state.images.length - 1));
    if (nextIndex === state.currentImageIndex) {
      return;
    }
    await runBusy("이미지 이동 중", async function () {
      if (state.annotationsDirty) {
        await saveCurrentAnnotations({ completeClaim: false });
      }
      captureAnnotationClipboard();
      state.currentImageIndex = nextIndex;
      await loadCurrentImage();
      setStatus("이미지를 이동했습니다.", "ok");
    });
  }

  async function loadCurrentImage() {
    cancelPendingBox();
    cancelBoxDraw();
    resetImageView();
    state.drawMode = false;
    state.selectedAnnotationIndex = -1;
    state.editingAnnotationIndex = -1;
    state.boxInteraction = null;
    state.annotationsDirty = false;
    var image = currentImage();
    if (!image) {
      state.annotations = [];
      state.imageLoad = { requestId: state.annotationRequestId, imageReady: false, annotationsReady: false };
      clearImagePreloads();
      els.claimedImage.removeAttribute("src");
      els.claimedImage.hidden = true;
      els.annotationOverlay.innerHTML = "";
      els.imageLoadingState.hidden = true;
      els.emptyState.hidden = false;
      renderAnnotationList();
      renderWorkerImageSummary();
      renderButtons();
      return;
    }

    var requestId = state.annotationRequestId + 1;
    state.annotationRequestId = requestId;
    state.imageLoad = { requestId: requestId, imageReady: false, annotationsReady: false };
    setImageStageNotice(true, "이미지 로딩 중", "서버에서 이미지를 불러오고 있습니다.");
    els.claimedImage.fetchPriority = "high";
    els.claimedImage.decoding = "async";
    els.claimedImage.src = authenticatedImageUrl(image);
    if (els.claimedImage.complete && els.claimedImage.naturalWidth > 0) {
      window.setTimeout(handleClaimedImageLoad, 0);
    }
    renderWorkerImageSummary();
    renderBoxLabelOptions();
    try {
      var data = await requestJson("/api/annotations?image_id=" + encodeURIComponent(image.id));
      if (requestId !== state.annotationRequestId) {
        return;
      }
      state.annotations = Array.isArray(data.annotations) ? data.annotations : [];
      state.annotationsDirty = false;
      if (data.image) {
        state.images[state.currentImageIndex] = data.image;
      }
      await persistCurrentCheckpoint();
      state.imageLoad.annotationsReady = true;
      renderWorkerImageSummary();
      renderAnnotationList();
      revealImageWhenReady(requestId);
      renderButtons();
    } catch (error) {
      state.annotations = [];
      renderAnnotationList();
      els.annotationOverlay.innerHTML = "";
      setImageStageNotice(true, "어노테이션을 불러오지 못했습니다", error.message);
      setStatus(error.message, "error");
    }
  }

  function handleClaimedImageLoad() {
    if (state.imageLoad.requestId !== state.annotationRequestId) {
      return;
    }
    state.imageLoad.imageReady = true;
    revealImageWhenReady(state.imageLoad.requestId);
    scheduleNearbyImagePreload();
  }

  function handleClaimedImageError() {
    if (state.imageLoad.requestId !== state.annotationRequestId) {
      return;
    }
    state.imageLoad.imageReady = false;
    state.imageLoad.annotationsReady = false;
    els.claimedImage.hidden = true;
    els.annotationOverlay.innerHTML = "";
    setImageStageNotice(true, "이미지를 불러오지 못했습니다", "서버 이미지 응답을 확인하세요.");
    setStatus("이미지를 불러오지 못했습니다.", "error");
  }

  function setImageStageNotice(visible, title, detail) {
    els.imageLoadingState.hidden = !visible;
    if (visible) {
      var titleNode = els.imageLoadingState.querySelector("strong");
      var detailNode = els.imageLoadingState.querySelector("span");
      if (titleNode) {
        titleNode.textContent = title || "이미지 로딩 중";
      }
      if (detailNode) {
        detailNode.textContent = detail || "서버에서 이미지를 불러오고 있습니다.";
      }
    }
    els.emptyState.hidden = true;
    els.claimedImage.hidden = true;
    els.annotationOverlay.innerHTML = "";
  }

  function revealImageWhenReady(requestId) {
    if (requestId !== state.annotationRequestId) {
      return;
    }
    if (!state.imageLoad.imageReady || !state.imageLoad.annotationsReady) {
      return;
    }
    setImageStageNotice(false);
    els.emptyState.hidden = true;
    els.claimedImage.hidden = false;
    renderAnnotationOverlay();
    renderButtons();
  }

  function scheduleNearbyImagePreload() {
    if (state.imagePreloadTimer) {
      window.clearTimeout(state.imagePreloadTimer);
    }
    state.imagePreloadTimer = window.setTimeout(function () {
      state.imagePreloadTimer = 0;
      preloadNearbyImages();
    }, 80);
  }

  function preloadNearbyImages() {
    if (!state.token || state.currentImageIndex < 0 || !state.images.length) {
      return;
    }
    var targets = [];
    for (var step = 1; step <= IMAGE_PRELOAD_FORWARD_COUNT; step += 1) {
      if (state.currentImageIndex + step < state.images.length) {
        targets.push(state.images[state.currentImageIndex + step]);
      }
      if (step <= IMAGE_PRELOAD_BACKWARD_COUNT && state.currentImageIndex - step >= 0) {
        targets.push(state.images[state.currentImageIndex - step]);
      }
    }
    targets.forEach(preloadImage);
    pruneImagePreloads();
  }

  function preloadImage(image) {
    if (!image || !image.url) {
      return;
    }
    var url = authenticatedImageUrl(image);
    var key = image.id + "|" + url;
    if (state.imagePreloads[key]) {
      state.imagePreloads[key].at = Date.now();
      return;
    }
    var preload = new Image();
    preload.decoding = "async";
    preload.fetchPriority = "low";
    state.imagePreloads[key] = { image: preload, at: Date.now() };
    state.imagePreloadOrder.push(key);
    preload.onerror = function () {
      delete state.imagePreloads[key];
    };
    preload.src = url;
  }

  function pruneImagePreloads() {
    while (state.imagePreloadOrder.length > IMAGE_PRELOAD_CACHE_LIMIT) {
      var key = state.imagePreloadOrder.shift();
      delete state.imagePreloads[key];
    }
  }

  function clearImagePreloads() {
    if (state.imagePreloadTimer) {
      window.clearTimeout(state.imagePreloadTimer);
      state.imagePreloadTimer = 0;
    }
    state.imagePreloads = {};
    state.imagePreloadOrder = [];
  }

  function renderWorkerImageSummary() {
    var image = currentImage();
    var total = state.images.length;
    els.filenameSummary.textContent = image ? image.relative_path || image.filename : "-";
    els.projectSummary.textContent = image ? image.project_name + " / " + image.folder_name : "-";
    els.imageStatusSummary.textContent = image ? statusForImage(image) : "-";
    els.currentImageCounter.textContent = total ? (state.currentImageIndex + 1) + " / " + total : "배정 이미지 없음";
    if (els.checkpointSummary) {
      els.checkpointSummary.textContent = checkpointSummaryText();
    }
    els.workerKeyboardHint.textContent = state.drawMode ? "박스를 드래그하세요. Esc 취소" : "A 이전, D 다음, W 박스 그리기";
    renderToolbarFolderMarkActions();
  }

  function renderAssignedFolders() {
    if (!els.assignedFolderList) {
      return;
    }
    var folders = assignedWorkerFolders();
    if (!folders.length) {
      els.assignedFolderList.innerHTML = '<div class="table-empty">배정된 작업 폴더가 없습니다.</div>';
      return;
    }
    els.assignedFolderList.innerHTML = folders.map(function (item) {
      var status = item.workerMark && item.workerMark.status ? item.workerMark.status : "";
      var statusText = status === "done" ? "완료" : (status === "review" ? "검수" : "작업중");
      var checkpointText = folderCheckpointText(item.workerCheckpoint, item.total);
      var activeClass = state.activeFolder.projectId === item.projectId && state.activeFolder.folderId === item.folderId ? " active" : "";
      return '<div class="assigned-folder-card' + activeClass + '">' +
        '<button class="assigned-folder-button" type="button" data-open-folder="1" data-project-id="' + escapeAttribute(item.projectId) + '" data-folder-id="' + escapeAttribute(item.folderId) + '">' +
          '<strong>' + escapeHtml(item.folderName) + '</strong>' +
          '<span>' + escapeHtml(item.projectName + " · " + item.labeled + "/" + item.total + " 완료 · 가능 " + item.available + " · " + statusText) + '</span>' +
          '<span>' + escapeHtml("체크포인트 " + checkpointText) + '</span>' +
        '</button>' +
        '<div class="folder-mark-actions">' +
          '<button class="button secondary compact' + ((!status || status === "working") ? " active" : "") + '" type="button" data-folder-mark="working" data-project-id="' + escapeAttribute(item.projectId) + '" data-folder-id="' + escapeAttribute(item.folderId) + '">작업중</button>' +
          '<button class="button secondary compact' + (status === "done" ? " active" : "") + '" type="button" data-folder-mark="done" data-project-id="' + escapeAttribute(item.projectId) + '" data-folder-id="' + escapeAttribute(item.folderId) + '">완료</button>' +
          '<button class="button secondary compact' + (status === "review" ? " active" : "") + '" type="button" data-folder-mark="review" data-project-id="' + escapeAttribute(item.projectId) + '" data-folder-id="' + escapeAttribute(item.folderId) + '">검수</button>' +
        '</div>' +
        '</div>';
    }).join("");
  }

  function assignedWorkerFolders() {
    var results = [];
    (state.worker.projects || []).forEach(function (project) {
      (project.folders || []).forEach(function (folder) {
        results.push({
          projectId: project.id,
          projectName: project.name,
          folderId: folder.id,
          folderName: folder.name,
          total: Number(folder.total) || 0,
          labeled: Number(folder.labeled) || 0,
          available: Number(folder.available) || 0,
          workerMark: folder.worker_mark || {},
          workerCheckpoint: folder.worker_checkpoint || {}
        });
      });
    });
    return results;
  }

  function activeAssignedFolder() {
    var folders = assignedWorkerFolders();
    if (state.activeFolder.projectId && state.activeFolder.folderId) {
      return folders.find(function (folder) {
        return folder.projectId === state.activeFolder.projectId && folder.folderId === state.activeFolder.folderId;
      }) || null;
    }
    var image = currentImage();
    if (image) {
      return folders.find(function (folder) {
        return folder.projectId === image.project_id && folder.folderId === image.folder_id;
      }) || null;
    }
    return null;
  }

  function renderToolbarFolderMarkActions() {
    if (!els.toolbarFolderMarkSelect) {
      return;
    }
    var folder = activeAssignedFolder();
    var status = folder && folder.workerMark && folder.workerMark.status ? folder.workerMark.status : "working";
    var disabled = state.busy || !folder;
    els.toolbarFolderMarkSelect.value = status;
    els.toolbarFolderMarkSelect.disabled = disabled;
  }

  function folderCheckpointText(checkpoint, totalFallback) {
    var total = Number(checkpoint && checkpoint.total) || Number(totalFallback) || 0;
    var position = Number(checkpoint && checkpoint.position) || 0;
    return position + "/" + total;
  }

  function checkpointSummaryText() {
    if (state.images.length && state.currentImageIndex >= 0) {
      return "체크포인트 " + (state.currentImageIndex + 1) + "/" + state.images.length;
    }
    var checkpoint = activeFolderCheckpoint();
    if (checkpoint) {
      return "체크포인트 " + folderCheckpointText(checkpoint, checkpoint.total);
    }
    return "체크포인트 -";
  }

  async function persistCurrentCheckpoint() {
    var image = currentImage();
    if (!image || !state.user || state.user.role === "admin") {
      return;
    }
    try {
      var data = await requestJson("/api/worker/checkpoint", {
        method: "POST",
        body: { image_id: image.id }
      });
      if (data && data.checkpoint) {
        updateLocalWorkerCheckpoint(image.project_id, image.folder_id, data.checkpoint);
        renderAssignedFolders();
      }
    } catch (error) {
      // Checkpoint persistence should not interrupt labeling.
    }
  }

  function updateLocalWorkerCheckpoint(projectId, folderId, checkpoint) {
    (state.worker.projects || []).forEach(function (project) {
      if (project.id !== projectId) {
        return;
      }
      (project.folders || []).forEach(function (folder) {
        if (folder.id === folderId) {
          folder.worker_checkpoint = checkpoint;
        }
      });
    });
  }

  function renderBoxLabelOptions(selectedLabelId) {
    var labels = labelsForImage(currentImage());
    if (!labels.length) {
      els.boxLabelList.innerHTML = '<div class="table-empty">라벨 없음</div>';
      return;
    }
    els.boxLabelList.innerHTML = labels.map(function (label) {
      var active = Number(label.id) === Number(selectedLabelId) ? " active" : "";
      var color = normalizeLabelColor(label.color, label.id);
      return '<button class="box-label-option' + active + '" type="button" data-box-label-id="' + escapeAttribute(label.id) + '" style="--label-color: ' + escapeAttribute(color) + ';">' +
        '<span>' + escapeHtml(label.id) + '</span>' +
        '<strong>' + escapeHtml(label.name) + '</strong>' +
        '</button>';
    }).join("");
  }

  function toggleDrawMode() {
    setDrawMode(!state.drawMode);
  }

  function setDrawMode(enabled) {
    if (enabled && !currentImage()) {
      setStatus("먼저 작업할 이미지를 선택하세요.", "error");
      return false;
    }
    state.drawMode = Boolean(enabled);
    cancelPendingBox();
    cancelBoxDraw();
    renderWorkerImageSummary();
    renderAnnotationOverlay();
    renderButtons();
    return true;
  }

  function handleWorkerKeydown(event) {
    if (!state.user || state.user.role === "admin" || els.workerPanel.hidden) {
      return;
    }
    if (state.busy) {
      return;
    }
    var tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
    if (["input", "textarea", "select"].indexOf(tag) >= 0) {
      return;
    }
    var key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "v") {
      event.preventDefault();
      pasteAnnotationClipboard();
    } else if ((key === "backspace" || key === "delete") && state.selectedAnnotationIndex >= 0) {
      event.preventDefault();
      cancelPendingBox();
      removeAnnotation(state.selectedAnnotationIndex);
    } else if (key === "a") {
      event.preventDefault();
      goToImage(state.currentImageIndex - 1);
    } else if (key === "d") {
      event.preventDefault();
      goToImage(state.currentImageIndex + 1);
    } else if (key === "w") {
      event.preventDefault();
      toggleDrawMode();
    } else if (key === "escape") {
      cancelPendingBox();
      cancelBoxDraw();
      state.drawMode = false;
      renderWorkerImageSummary();
      renderAnnotationOverlay();
      renderButtons();
    }
  }

  function getBaseImageRect() {
    var stageRect = els.imageStage.getBoundingClientRect();
    var image = els.claimedImage;
    if (!image.naturalWidth || !image.naturalHeight || stageRect.width <= 0 || stageRect.height <= 0) {
      return null;
    }
    var stageRatio = stageRect.width / stageRect.height;
    var imageRatio = image.naturalWidth / image.naturalHeight;
    var width;
    var height;
    var left;
    var top;
    if (stageRatio > imageRatio) {
      height = stageRect.height;
      width = height * imageRatio;
      left = (stageRect.width - width) / 2;
      top = 0;
    } else {
      width = stageRect.width;
      height = width / imageRatio;
      left = 0;
      top = (stageRect.height - height) / 2;
    }
    return { left: left, top: top, width: width, height: height, stageWidth: stageRect.width, stageHeight: stageRect.height };
  }

  function getRenderedImageRect() {
    var base = getBaseImageRect();
    if (!base) {
      return null;
    }
    var scale = state.imageView.scale;
    var centerX = base.stageWidth / 2;
    var centerY = base.stageHeight / 2;
    return {
      left: centerX + state.imageView.offsetX - (base.width * scale) / 2,
      top: centerY + state.imageView.offsetY - (base.height * scale) / 2,
      width: base.width * scale,
      height: base.height * scale,
      stageWidth: base.stageWidth,
      stageHeight: base.stageHeight
    };
  }

  function resetImageView() {
    state.imageView.scale = 1;
    state.imageView.offsetX = 0;
    state.imageView.offsetY = 0;
    state.imageView.panning = null;
    applyImageViewTransform();
  }

  function applyImageViewTransform() {
    if (!els.claimedImage || !els.imageStage) {
      return;
    }
    var view = state.imageView;
    els.claimedImage.style.transform = "matrix(" + view.scale + ", 0, 0, " + view.scale + ", " + view.offsetX + ", " + view.offsetY + ")";
    els.imageStage.classList.toggle("zoomed", view.scale > 1.001);
    els.imageStage.classList.toggle("panning", Boolean(view.panning));
  }

  function clampImageView() {
    var base = getBaseImageRect();
    if (!base) {
      return;
    }
    var view = state.imageView;
    view.scale = clamp(view.scale, 1, 8);
    if (view.scale <= 1.001) {
      view.scale = 1;
      view.offsetX = 0;
      view.offsetY = 0;
      return;
    }
    var maxOffsetX = Math.max(0, (base.width * view.scale - base.stageWidth) / 2);
    var maxOffsetY = Math.max(0, (base.height * view.scale - base.stageHeight) / 2);
    view.offsetX = clamp(view.offsetX, -maxOffsetX, maxOffsetX);
    view.offsetY = clamp(view.offsetY, -maxOffsetY, maxOffsetY);
  }

  function handleStageResize() {
    clampImageView();
    applyImageViewTransform();
    renderAnnotationOverlay();
  }

  function handleStageWheel(event) {
    if (!currentImage() || closestElement(event.target, ".box-label-picker")) {
      return;
    }
    var base = getBaseImageRect();
    if (!base) {
      return;
    }
    event.preventDefault();
    cancelPendingBox();
    var stageRect = els.imageStage.getBoundingClientRect();
    var pointerX = event.clientX - stageRect.left;
    var pointerY = event.clientY - stageRect.top;
    var centerX = base.stageWidth / 2;
    var centerY = base.stageHeight / 2;
    var previousScale = state.imageView.scale;
    var nextScale = clamp(previousScale * Math.exp(-event.deltaY * 0.0015), 1, 8);
    var relativeX = (pointerX - centerX - state.imageView.offsetX) / previousScale;
    var relativeY = (pointerY - centerY - state.imageView.offsetY) / previousScale;
    state.imageView.scale = nextScale;
    state.imageView.offsetX = pointerX - centerX - relativeX * nextScale;
    state.imageView.offsetY = pointerY - centerY - relativeY * nextScale;
    clampImageView();
    applyImageViewTransform();
    renderAnnotationOverlay();
  }

  function normalizedPointFromEvent(event) {
    var stageRect = els.imageStage.getBoundingClientRect();
    var imageRect = getRenderedImageRect();
    if (!imageRect) {
      return null;
    }
    var x = (event.clientX - stageRect.left - imageRect.left) / imageRect.width;
    var y = (event.clientY - stageRect.top - imageRect.top) / imageRect.height;
    return { x: clamp01(x), y: clamp01(y) };
  }

  function beginBoxDraw(event) {
    if (event.button !== 0) {
      return;
    }
    if (!currentImage() || closestElement(event.target, ".box-label-picker")) {
      return;
    }
    var annotationTarget = closestElement(event.target, "[data-annotation-index]");
    if (annotationTarget) {
      beginAnnotationInteraction(event, annotationTarget);
      return;
    }
    if (!state.drawMode) {
      if (state.imageView.scale > 1.001) {
        beginImagePan(event);
        return;
      }
      if (state.selectedAnnotationIndex !== -1) {
        state.selectedAnnotationIndex = -1;
        renderAnnotationOverlay();
      }
      return;
    }
    var point = normalizedPointFromEvent(event);
    if (!point) {
      return;
    }
    event.preventDefault();
    els.imageStage.setPointerCapture(event.pointerId);
    state.drawingBox = { startX: point.x, startY: point.y, endX: point.x, endY: point.y };
    renderAnnotationOverlay();
  }

  function updateBoxDraw(event) {
    if (state.imageView.panning) {
      updateImagePan(event);
      return;
    }
    if (state.boxInteraction) {
      updateAnnotationInteraction(event);
      return;
    }
    if (!state.drawingBox) {
      return;
    }
    var point = normalizedPointFromEvent(event);
    if (!point) {
      return;
    }
    state.drawingBox.endX = point.x;
    state.drawingBox.endY = point.y;
    renderAnnotationOverlay();
  }

  function endBoxDraw(event) {
    if (state.imageView.panning) {
      endImagePan(event);
      return;
    }
    if (state.boxInteraction) {
      endAnnotationInteraction(event);
      return;
    }
    if (!state.drawingBox) {
      return;
    }
    var point = normalizedPointFromEvent(event);
    if (point) {
      state.drawingBox.endX = point.x;
      state.drawingBox.endY = point.y;
    }
    var box = boxFromDrag(state.drawingBox);
    state.drawingBox = null;
    if (!box || box.width < 0.005 || box.height < 0.005) {
      renderAnnotationOverlay();
      return;
    }
    state.pendingBox = box;
    showBoxLabelPicker(box);
    renderAnnotationOverlay();
  }

  function cancelBoxDraw() {
    state.drawingBox = null;
    state.boxInteraction = null;
    state.imageView.panning = null;
    applyImageViewTransform();
  }

  function beginImagePan(event) {
    event.preventDefault();
    event.stopPropagation();
    cancelPendingBox();
    state.selectedAnnotationIndex = -1;
    state.imageView.panning = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: state.imageView.offsetX,
      startOffsetY: state.imageView.offsetY
    };
    els.imageStage.setPointerCapture(event.pointerId);
    applyImageViewTransform();
    renderAnnotationOverlay();
  }

  function updateImagePan(event) {
    var pan = state.imageView.panning;
    if (!pan) {
      return;
    }
    event.preventDefault();
    state.imageView.offsetX = pan.startOffsetX + event.clientX - pan.startX;
    state.imageView.offsetY = pan.startOffsetY + event.clientY - pan.startY;
    clampImageView();
    applyImageViewTransform();
    renderAnnotationOverlay();
  }

  function endImagePan(event) {
    event.preventDefault();
    if (state.imageView.panning && els.imageStage.hasPointerCapture(state.imageView.panning.pointerId)) {
      els.imageStage.releasePointerCapture(state.imageView.panning.pointerId);
    }
    state.imageView.panning = null;
    applyImageViewTransform();
  }

  function beginAnnotationInteraction(event, target) {
    var index = parseInt(target.dataset.annotationIndex, 10);
    if (Number.isNaN(index) || index < 0 || index >= state.annotations.length) {
      return;
    }
    var point = normalizedPointFromEvent(event);
    if (!point) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    cancelPendingBox();
    state.drawMode = false;
    state.selectedAnnotationIndex = index;
    renderAnnotationList();
    state.boxInteraction = {
      index: index,
      mode: target.dataset.resizeHandle ? "resize" : "move",
      handle: target.dataset.resizeHandle || "",
      pointerId: event.pointerId,
      startPoint: point,
      startBox: annotationBoxCopy(state.annotations[index]),
      moved: false
    };
    els.imageStage.setPointerCapture(event.pointerId);
    renderWorkerImageSummary();
    renderAnnotationOverlay();
    renderButtons();
  }

  function updateAnnotationInteraction(event) {
    var interaction = state.boxInteraction;
    var point = normalizedPointFromEvent(event);
    if (!interaction || !point) {
      return;
    }
    var annotation = state.annotations[interaction.index];
    if (!annotation) {
      state.boxInteraction = null;
      return;
    }
    event.preventDefault();
    var nextBox = interaction.mode === "resize"
      ? resizedAnnotationBox(interaction.startBox, interaction.handle, point)
      : movedAnnotationBox(interaction.startBox, point.x - interaction.startPoint.x, point.y - interaction.startPoint.y);
    if (!annotationBoxesEqual(annotation, nextBox)) {
      annotation.x = nextBox.x;
      annotation.y = nextBox.y;
      annotation.width = nextBox.width;
      annotation.height = nextBox.height;
      interaction.moved = true;
      state.annotationsDirty = true;
      renderAnnotationList();
      renderAnnotationOverlay();
      renderButtons();
    }
  }

  function endAnnotationInteraction(event) {
    event.preventDefault();
    var interaction = state.boxInteraction;
    if (interaction && els.imageStage.hasPointerCapture(interaction.pointerId)) {
      els.imageStage.releasePointerCapture(interaction.pointerId);
    }
    state.boxInteraction = null;
    if (interaction && interaction.mode === "move" && !interaction.moved) {
      if (isAnnotationDoubleClick(interaction.index)) {
        openAnnotationLabelEditorForIndex(interaction.index, event);
        return;
      }
      state.lastAnnotationClick = { index: interaction.index, at: Date.now() };
    }
    renderAnnotationOverlay();
  }

  function isAnnotationDoubleClick(index) {
    var now = Date.now();
    return state.lastAnnotationClick.index === index && now - state.lastAnnotationClick.at <= 420;
  }

  function openAnnotationLabelEditorForIndex(index, event) {
    if (Number.isNaN(index) || index < 0 || index >= state.annotations.length) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    state.lastAnnotationClick = { index: -1, at: 0 };
    cancelBoxDraw();
    state.pendingBox = null;
    state.drawMode = false;
    state.selectedAnnotationIndex = index;
    showBoxLabelPicker(state.annotations[index], index);
    renderWorkerImageSummary();
    renderAnnotationOverlay();
    renderButtons();
  }

  function movedAnnotationBox(box, dx, dy) {
    var halfWidth = box.width / 2;
    var halfHeight = box.height / 2;
    return {
      x: clamp(box.x + dx, halfWidth, 1 - halfWidth),
      y: clamp(box.y + dy, halfHeight, 1 - halfHeight),
      width: box.width,
      height: box.height
    };
  }

  function resizedAnnotationBox(box, handle, point) {
    var minSize = 0.005;
    var left = box.x - box.width / 2;
    var right = box.x + box.width / 2;
    var top = box.y - box.height / 2;
    var bottom = box.y + box.height / 2;
    if (handle.indexOf("w") >= 0) {
      left = clamp(point.x, 0, right - minSize);
    }
    if (handle.indexOf("e") >= 0) {
      right = clamp(point.x, left + minSize, 1);
    }
    if (handle.indexOf("n") >= 0) {
      top = clamp(point.y, 0, bottom - minSize);
    }
    if (handle.indexOf("s") >= 0) {
      bottom = clamp(point.y, top + minSize, 1);
    }
    return {
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      width: right - left,
      height: bottom - top
    };
  }

  function annotationBoxCopy(annotation) {
    return {
      x: Number(annotation.x) || 0,
      y: Number(annotation.y) || 0,
      width: Number(annotation.width) || 0,
      height: Number(annotation.height) || 0
    };
  }

  function annotationBoxesEqual(a, b) {
    var epsilon = 0.000001;
    return Math.abs((Number(a.x) || 0) - b.x) < epsilon &&
      Math.abs((Number(a.y) || 0) - b.y) < epsilon &&
      Math.abs((Number(a.width) || 0) - b.width) < epsilon &&
      Math.abs((Number(a.height) || 0) - b.height) < epsilon;
  }

  function boxFromDrag(drag) {
    if (!drag) {
      return null;
    }
    var left = Math.min(drag.startX, drag.endX);
    var right = Math.max(drag.startX, drag.endX);
    var top = Math.min(drag.startY, drag.endY);
    var bottom = Math.max(drag.startY, drag.endY);
    return {
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      width: right - left,
      height: bottom - top
    };
  }

  function showBoxLabelPicker(box, editIndex) {
    var editing = typeof editIndex === "number" && editIndex >= 0;
    var selectedLabelId = editing && state.annotations[editIndex] ? state.annotations[editIndex].label_id : undefined;
    state.editingAnnotationIndex = editing ? editIndex : -1;
    renderBoxLabelOptions(selectedLabelId);
    var imageRect = getRenderedImageRect();
    if (!imageRect) {
      return;
    }
    var left = imageRect.left + (box.x + box.width / 2) * imageRect.width;
    var top = imageRect.top + Math.max(0, box.y - box.height / 2) * imageRect.height;
    els.boxLabelPicker.style.left = Math.min(Math.max(left, 12), imageRect.stageWidth - 260) + "px";
    els.boxLabelPicker.style.top = Math.min(Math.max(top + 10, 12), imageRect.stageHeight - 220) + "px";
    els.boxLabelPicker.hidden = false;
    var firstButton = els.boxLabelList.querySelector("[data-box-label-id]");
    if (firstButton) {
      firstButton.focus();
    }
  }

  function confirmPendingBox(labelId) {
    if (!state.pendingBox && state.editingAnnotationIndex < 0) {
      return;
    }
    if (Number.isNaN(labelId)) {
      setStatus("라벨을 선택하세요.", "error");
      return;
    }
    var label = labelsForImage(currentImage()).find(function (item) {
      return Number(item.id) === labelId;
    });
    if (state.editingAnnotationIndex >= 0) {
      var annotation = state.annotations[state.editingAnnotationIndex];
      if (!annotation) {
        cancelPendingBox();
        return;
      }
      annotation.label_id = labelId;
      annotation.label_name = label ? label.name : String(labelId);
      annotation.label_color = label ? label.color : defaultLabelColor(labelId);
      state.annotationsDirty = true;
      state.editingAnnotationIndex = -1;
      els.boxLabelPicker.hidden = true;
      renderAnnotationList();
      renderAnnotationOverlay();
      renderButtons();
      return;
    }
    state.annotations.push({
      label_id: labelId,
      label_name: label ? label.name : String(labelId),
      label_color: label ? label.color : defaultLabelColor(labelId),
      x: state.pendingBox.x,
      y: state.pendingBox.y,
      width: state.pendingBox.width,
      height: state.pendingBox.height
    });
    state.annotationsDirty = true;
    state.pendingBox = null;
    state.selectedAnnotationIndex = state.annotations.length - 1;
    els.boxLabelPicker.hidden = true;
    state.drawMode = false;
    renderAnnotationList();
    renderAnnotationOverlay();
    renderWorkerImageSummary();
    renderButtons();
  }

  function cancelPendingBox() {
    state.pendingBox = null;
    state.editingAnnotationIndex = -1;
    state.boxInteraction = null;
    if (els.boxLabelPicker) {
      els.boxLabelPicker.hidden = true;
    }
  }

  function removeAnnotation(index) {
    if (Number.isNaN(index) || index < 0 || index >= state.annotations.length) {
      return;
    }
    state.annotations.splice(index, 1);
    if (state.selectedAnnotationIndex === index) {
      state.selectedAnnotationIndex = -1;
    } else if (state.selectedAnnotationIndex > index) {
      state.selectedAnnotationIndex -= 1;
    }
    if (state.editingAnnotationIndex === index) {
      cancelPendingBox();
    } else if (state.editingAnnotationIndex > index) {
      state.editingAnnotationIndex -= 1;
    }
    state.annotationsDirty = true;
    renderAnnotationList();
    renderAnnotationOverlay();
    renderButtons();
  }

  function captureAnnotationClipboard() {
    state.annotationClipboard = state.annotations.map(function (annotation) {
      return cloneAnnotation(annotation);
    });
  }

  function pasteAnnotationClipboard() {
    if (!currentImage()) {
      setStatus("붙여넣을 이미지가 없습니다.", "error");
      return;
    }
    if (!state.annotationClipboard.length) {
      setStatus("복사할 이전 라벨링이 없습니다.", "error");
      return;
    }
    var labels = labelsForImage(currentImage());
    var labelsById = {};
    labels.forEach(function (label) {
      labelsById[Number(label.id)] = label;
    });
    var skipped = 0;
    var pasted = state.annotationClipboard.reduce(function (items, annotation) {
      var copy = cloneAnnotation(annotation);
      if (!labelsById.hasOwnProperty(copy.label_id)) {
        skipped += 1;
        return items;
      }
      copy.label_name = labelsById[copy.label_id].name;
      copy.label_color = labelsById[copy.label_id].color;
      items.push(copy);
      return items;
    }, []);
    if (!pasted.length) {
      setStatus("현재 프로젝트 라벨과 맞는 이전 라벨링이 없습니다.", "error");
      return;
    }
    cancelPendingBox();
    cancelBoxDraw();
    state.annotations = pasted;
    state.annotationsDirty = true;
    state.selectedAnnotationIndex = -1;
    renderAnnotationList();
    renderAnnotationOverlay();
    renderButtons();
    setStatus("이전 라벨링 " + pasted.length + "개를 붙여넣었습니다." + (skipped ? " 맞지 않는 라벨 " + skipped + "개는 제외했습니다." : ""), "ok");
  }

  function cloneAnnotation(annotation) {
    return {
      label_id: Number(annotation.label_id),
      label_name: annotation.label_name,
      label_color: annotation.label_color,
      x: Number(annotation.x),
      y: Number(annotation.y),
      width: Number(annotation.width),
      height: Number(annotation.height)
    };
  }

  function labelColorForAnnotation(annotation) {
    var labelId = Number(annotation && annotation.label_id);
    var labels = labelsForImage(currentImage());
    var label = labels.find(function (item) {
      return Number(item.id) === labelId;
    });
    return normalizeLabelColor(label ? label.color : annotation && annotation.label_color, Number.isNaN(labelId) ? 0 : labelId);
  }

  function hexToRgba(hex, alpha) {
    var color = normalizeLabelColor(hex, 0);
    var red = parseInt(color.slice(1, 3), 16);
    var green = parseInt(color.slice(3, 5), 16);
    var blue = parseInt(color.slice(5, 7), 16);
    return "rgba(" + red + ", " + green + ", " + blue + ", " + alpha + ")";
  }

  function renderAnnotationOverlay() {
    if (!els.annotationOverlay) {
      return;
    }
    var imageRect = getRenderedImageRect();
    if (!currentImage() || !imageRect || !state.imageLoad.imageReady || !state.imageLoad.annotationsReady) {
      els.annotationOverlay.innerHTML = "";
      return;
    }
    els.annotationOverlay.setAttribute("viewBox", "0 0 " + imageRect.stageWidth + " " + imageRect.stageHeight);
    var boxes = state.annotations.map(function (annotation, index) {
      return renderSvgBox(annotation, index, imageRect, false);
    });
    if (state.drawingBox) {
      var draft = boxFromDrag(state.drawingBox);
      if (draft) {
        boxes.push(renderSvgBox({ label_name: "새 박스", x: draft.x, y: draft.y, width: draft.width, height: draft.height }, -1, imageRect, true));
      }
    }
    if (state.pendingBox) {
      boxes.push(renderSvgBox({ label_name: "라벨 선택", x: state.pendingBox.x, y: state.pendingBox.y, width: state.pendingBox.width, height: state.pendingBox.height }, -1, imageRect, true));
    }
    els.annotationOverlay.innerHTML = boxes.join("");
  }

  function renderSvgBox(annotation, index, imageRect, draft) {
    var left = imageRect.left + (annotation.x - annotation.width / 2) * imageRect.width;
    var top = imageRect.top + (annotation.y - annotation.height / 2) * imageRect.height;
    var width = annotation.width * imageRect.width;
    var height = annotation.height * imageRect.height;
    var label = draft ? annotation.label_name : (index + 1) + ". " + annotation.label_name;
    var selected = !draft && index === state.selectedAnnotationIndex;
    var stroke = draft ? "#f0a202" : labelColorForAnnotation(annotation);
    var fill = draft ? "rgba(240, 162, 2, 0.12)" : hexToRgba(stroke, selected ? 0.18 : 0.10);
    var labelY = Math.max(18, top - 6);
    var dataAttributes = draft ? "" : ' data-annotation-index="' + escapeAttribute(index) + '"';
    var handles = selected ? renderResizeHandles(index, left, top, width, height) : "";
    return '<g class="annotation-box' + (draft ? " annotation-box-draft" : "") + (selected ? " selected" : "") + '"' + dataAttributes + '>' +
      '<rect class="annotation-box-rect" x="' + escapeAttribute(left.toFixed(2)) + '" y="' + escapeAttribute(top.toFixed(2)) + '" width="' + escapeAttribute(width.toFixed(2)) + '" height="' + escapeAttribute(height.toFixed(2)) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + (selected ? "3" : "2") + '"></rect>' +
      '<text class="annotation-box-text" x="' + escapeAttribute(left.toFixed(2)) + '" y="' + escapeAttribute(labelY.toFixed(2)) + '" fill="' + stroke + '" font-size="13" font-weight="700">' + escapeHtml(label) + '</text>' +
      handles +
      '</g>';
  }

  function renderResizeHandles(index, left, top, width, height) {
    var size = 10;
    var half = size / 2;
    var corners = [
      { handle: "nw", x: left, y: top },
      { handle: "ne", x: left + width, y: top },
      { handle: "sw", x: left, y: top + height },
      { handle: "se", x: left + width, y: top + height }
    ];
    return corners.map(function (corner) {
      return '<rect class="annotation-handle annotation-handle-' + escapeAttribute(corner.handle) + '" data-annotation-index="' + escapeAttribute(index) + '" data-resize-handle="' + escapeAttribute(corner.handle) + '" x="' + escapeAttribute((corner.x - half).toFixed(2)) + '" y="' + escapeAttribute((corner.y - half).toFixed(2)) + '" width="' + escapeAttribute(size) + '" height="' + escapeAttribute(size) + '" rx="2"></rect>';
    }).join("");
  }

  function selectAnnotation(index) {
    if (Number.isNaN(index) || index < 0 || index >= state.annotations.length) {
      return;
    }
    cancelPendingBox();
    cancelBoxDraw();
    state.drawMode = false;
    state.selectedAnnotationIndex = index;
    renderAnnotationList();
    renderAnnotationOverlay();
    renderWorkerImageSummary();
    renderButtons();
  }

  function renderAnnotationList() {
    if (!state.annotations.length) {
      els.annotationList.innerHTML = '<div class="table-empty">아직 라벨링한 박스가 없습니다.</div>';
      return;
    }
    els.annotationList.innerHTML = state.annotations.map(function (annotation, index) {
      var color = labelColorForAnnotation(annotation);
      var selected = index === state.selectedAnnotationIndex;
      return '<div class="annotation-row' + (selected ? " selected" : "") + '" data-select-annotation="' + escapeAttribute(index) + '">' +
        '<div><strong><i class="annotation-color-dot" style="--label-color: ' + escapeAttribute(color) + ';"></i>' + escapeHtml(index + 1 + ". " + annotation.label_name) + '</strong>' +
        '<span>' + escapeHtml("x " + percent(annotation.x) + ", y " + percent(annotation.y) + ", w " + percent(annotation.width) + ", h " + percent(annotation.height)) + '</span></div>' +
        '<button class="button danger compact" type="button" data-remove-annotation="' + escapeAttribute(index) + '">삭제</button>' +
        '</div>';
    }).join("");
  }

  async function saveAnnotations() {
    var image = currentImage();
    if (!image) {
      setStatus("저장할 이미지가 없습니다.", "error");
      return;
    }
    await runBusy("라벨링 저장 중", async function () {
      await saveCurrentAnnotations({ completeClaim: true });
      renderWorkerImageSummary();
      renderAnnotationList();
      renderAnnotationOverlay();
      renderButtons();
      setStatus("YOLO 라벨을 저장했습니다.", "ok");
    });
  }

  async function saveCurrentAnnotations(options) {
    var opts = options || {};
    var image = currentImage();
    if (!image) {
      throw new Error("저장할 이미지가 없습니다.");
    }
    var completeClaim = Boolean(opts.completeClaim);
    var data = await requestJson("/api/annotations", {
      method: "POST",
      body: {
        image_id: image.id,
        claim_id: completeClaim && state.claim && state.claim.image && state.claim.image.id === image.id ? state.claim.claim_id : "",
        annotations: state.annotations.map(function (annotation) {
          return {
            label_id: annotation.label_id,
            x: annotation.x,
            y: annotation.y,
            width: annotation.width,
            height: annotation.height
          };
        })
      }
    });
    state.annotations = Array.isArray(data.annotations) ? data.annotations : state.annotations;
    state.annotationsDirty = false;
    if (data.image) {
      state.images[state.currentImageIndex] = data.image;
    }
    if (completeClaim && state.claim && state.claim.image && state.claim.image.id === image.id) {
      state.claim = null;
      localStorage.removeItem(CLAIM_KEY);
    }
    return data;
  }

  async function openWorkerFolder(projectId, folderId) {
    if (state.busy) {
      return;
    }
    await runBusy("작업 폴더를 여는 중", async function () {
      if (state.annotationsDirty) {
        await saveCurrentAnnotations({ completeClaim: false });
      }
      await releaseCurrentClaimBeforeSwitch();
      state.activeFolder = { projectId: projectId || "", folderId: folderId || "" };
      state.startAtCheckpoint = true;
      closeFolderPicker();
      await refreshWorker();
      setStatus(folderId ? "작업 폴더를 열었습니다." : "전체 작업 폴더를 열었습니다.", "ok");
    });
  }

  async function setWorkerFolderMark(projectId, folderId, status, options) {
    var opts = options || {};
    if (state.busy) {
      return;
    }
    await runBusy("작업 상태 저장 중", async function () {
      if (state.annotationsDirty) {
        await saveCurrentAnnotations({ completeClaim: false });
      }
      await requestJson("/api/worker/folder-mark", {
        method: "POST",
        body: { project_id: projectId, folder_id: folderId, status: status }
      });
      await refreshWorker();
      if (opts.reopenPicker !== false) {
        openFolderPicker();
      }
      setStatus(folderMarkStatusText(status) + " 상태로 표시했습니다.", "ok");
    });
  }

  function folderMarkStatusText(status) {
    if (status === "review") {
      return "검수";
    }
    if (status === "done") {
      return "완료";
    }
    return "작업중";
  }

  async function claimImage(projectId, folderId) {
    if (state.annotationsDirty && !window.confirm("저장하지 않은 라벨링이 있습니다. 새 이미지를 불러올까요?")) {
      return;
    }
    await runBusy("이미지를 불러오는 중", async function () {
      await releaseCurrentClaimBeforeSwitch();
      var body = folderId ? { project_id: projectId, folder_id: folderId } : undefined;
      var data = await requestJson("/api/claim", { method: "POST", body: body });
      state.claim = { image: data.image, claim_id: data.claim_id, expires_at: data.expires_at, labels: data.labels || [] };
      localStorage.setItem(CLAIM_KEY, JSON.stringify(state.claim));
      els.notesInput.value = "";
      closeFolderPicker();
      renderClaim();
      setStatus("이미지를 불러왔습니다.", "ok");
      await refreshWorker();
    });
  }

  async function releaseCurrentClaimBeforeSwitch() {
    if (!state.claim || !state.claim.claim_id) {
      return;
    }
    try {
      await requestJson("/api/release", {
        method: "POST",
        body: { claim_id: state.claim.claim_id }
      });
    } catch (error) {
      // The existing claim may already be expired or completed; switching should still proceed.
    }
    state.claim = null;
    state.annotations = [];
    state.annotationsDirty = false;
    state.selectedAnnotationIndex = -1;
    state.editingAnnotationIndex = -1;
    state.boxInteraction = null;
    resetImageView();
    localStorage.removeItem(CLAIM_KEY);
  }

  function openFolderPicker() {
    renderAssignedFolders();
    els.folderPickerModal.hidden = false;
  }

  function closeFolderPicker() {
    els.folderPickerModal.hidden = true;
  }

  async function saveLabel() {
    if (!state.claim || !state.claim.image) {
      setStatus("먼저 이미지를 받으세요.", "error");
      return;
    }
    var labelId = parseInt(els.labelInput.value, 10);
    if (Number.isNaN(labelId)) {
      setStatus("라벨을 선택하세요.", "error");
      return;
    }
    await runBusy("라벨 저장 중", async function () {
      await requestJson("/api/labels", {
        method: "POST",
        body: {
          image_id: state.claim.image.id,
          claim_id: state.claim.claim_id,
          label_id: labelId,
          notes: els.notesInput.value.trim()
        }
      });
      state.claim = null;
      localStorage.removeItem(CLAIM_KEY);
      els.notesInput.value = "";
      renderClaim();
      setStatus("YOLO 라벨 파일을 저장했습니다.", "ok");
      await refreshAll();
    });
  }

  async function releaseClaim() {
    if (!state.claim) {
      return;
    }
    await runBusy("작업 반납 중", async function () {
      await requestJson("/api/release", {
        method: "POST",
        body: { claim_id: state.claim.claim_id }
      });
      state.claim = null;
      localStorage.removeItem(CLAIM_KEY);
      renderClaim();
      setStatus("작업을 반납했습니다.", "ok");
      await refreshAll();
    });
  }

  function openProjectModal() {
    state.editingProjectId = "";
    els.projectModalTitle.textContent = "프로젝트 생성";
    els.projectModalDescription.textContent = "프로젝트 이름, 라벨 목록, 서버 로컬 접근 폴더를 설정합니다.";
    els.createProjectButton.textContent = "프로젝트 생성";
    els.projectNameInput.value = "";
    els.projectLabelNameInput.value = "";
    state.projectLabels = defaultProjectLabels();
    if (els.projectLabelColorInput) {
      els.projectLabelColorInput.value = nextAvailableLabelColor(state.projectLabels);
    }
    state.folderBrowser.selectedFolders = [];
    els.projectModal.hidden = false;
    els.projectNameInput.focus();
    renderProjectLabelEditor();
    renderSelectedFolders();
    if (!state.folderBrowser.entries.length) {
      browseFolders(state.folderBrowser.currentPath || "");
    } else {
      renderFolderBrowser();
    }
  }

  function closeProjectModal() {
    els.projectModal.hidden = true;
    state.editingProjectId = "";
  }

  function openProjectEditModal(projectId) {
    var project = (state.admin.projects || []).find(function (item) { return item.id === projectId; });
    if (!project) {
      setStatus("프로젝트를 찾을 수 없습니다.", "error");
      return;
    }
    state.editingProjectId = projectId;
    els.projectModalTitle.textContent = "프로젝트 수정";
    els.projectModalDescription.textContent = "프로젝트 정보와 라벨 목록을 수정하고, 새 YOLO 상위 폴더를 추가 등록합니다.";
    els.createProjectButton.textContent = "수정 저장";
    els.projectNameInput.value = project.name || "";
    els.projectLabelNameInput.value = "";
    state.projectLabels = (project.labels || []).map(normalizeProjectLabel).filter(function (label) { return label.name; });
    if (els.projectLabelColorInput) {
      els.projectLabelColorInput.value = nextAvailableLabelColor(state.projectLabels);
    }
    state.folderBrowser.selectedFolders = [];
    var existingPaths = selectedFolderPathsForProject(project);
    var primaryPath = existingPaths.length ? existingPaths[0] : "";
    els.folderPathInput.value = primaryPath;
    els.projectModal.hidden = false;
    els.projectNameInput.focus();
    renderProjectLabelEditor();
    renderSelectedFolders();
    if (primaryPath) {
      browseFolders(primaryPath);
    } else if (!state.folderBrowser.entries.length) {
      browseFolders("");
    } else {
      renderFolderBrowser();
    }
  }

  function selectedFolderPathsForProject(project) {
    var paths = [];
    (project.folders || []).forEach(function (folder) {
      var path = folder.source_path || parentPathForFolder(folder.root_path || "");
      if (path && paths.indexOf(path) < 0) {
        paths.push(path);
      }
    });
    return paths;
  }

  function parentPathForFolder(path) {
    var value = String(path || "").replace(/[\\\/]+$/, "");
    var slashIndex = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
    return slashIndex > 0 ? value.slice(0, slashIndex) : value;
  }

  async function browseFolders(path) {
    await runBusy("폴더 목록을 불러오는 중", async function () {
      var url = "/api/admin/folders/browse";
      if (path) {
        url += "?path=" + encodeURIComponent(path);
      }
      var data = await requestJson(url);
      state.folderBrowser.currentPath = data.current_path || "";
      state.folderBrowser.parentPath = data.parent_path || "";
      state.folderBrowser.entries = Array.isArray(data.entries) ? data.entries : [];
      renderFolderBrowser();
    });
  }

  function addSelectedFolder(path) {
    if (!path) {
      return;
    }
    if (state.folderBrowser.selectedFolders.indexOf(path) < 0) {
      state.folderBrowser.selectedFolders.push(path);
    }
    renderSelectedFolders();
  }

  function removeSelectedFolder(path) {
    state.folderBrowser.selectedFolders = state.folderBrowser.selectedFolders.filter(function (item) {
      return item !== path;
    });
    renderSelectedFolders();
  }

  function addProjectLabel() {
    var labelName = els.projectLabelNameInput.value.trim();
    if (!labelName) {
      setStatus("추가할 라벨 이름을 입력하세요.", "error");
      return;
    }
    var exists = state.projectLabels.some(function (item) {
      return String(item.name || "").toLowerCase() === labelName.toLowerCase();
    });
    if (exists) {
      setStatus("이미 추가된 라벨입니다.", "error");
      return;
    }
    var index = state.projectLabels.length;
    state.projectLabels.push({
      id: index,
      name: labelName,
      color: normalizeLabelColor(els.projectLabelColorInput ? els.projectLabelColorInput.value : "", index)
    });
    els.projectLabelNameInput.value = "";
    if (els.projectLabelColorInput) {
      els.projectLabelColorInput.value = nextAvailableLabelColor(state.projectLabels);
    }
    renderProjectLabelEditor();
  }

  function updateProjectLabelColor(index, color) {
    if (Number.isNaN(index) || index < 0 || index >= state.projectLabels.length) {
      return;
    }
    state.projectLabels[index] = {
      id: index,
      name: state.projectLabels[index].name,
      color: normalizeLabelColor(color, index)
    };
  }

  function removeProjectLabel(index) {
    if (Number.isNaN(index)) {
      return;
    }
    state.projectLabels.splice(index, 1);
    if (els.projectLabelColorInput) {
      els.projectLabelColorInput.value = nextAvailableLabelColor(state.projectLabels);
    }
    renderProjectLabelEditor();
  }

  async function createUser() {
    var username = els.newUsernameInput.value.trim();
    var password = els.newPasswordInput.value;
    var role = els.newRoleSelect.value;
    if (!username || !password) {
      setStatus("사용자 아이디와 비밀번호를 입력하세요.", "error");
      return;
    }
    await runBusy("사용자 생성 중", async function () {
      await requestJson("/api/admin/users", { method: "POST", body: { username: username, password: password, role: role } });
      els.newUsernameInput.value = "";
      els.newPasswordInput.value = "";
      setStatus("사용자를 생성했습니다.", "ok");
      await refreshAdmin();
    });
  }

  async function createTempUser() {
    var username = "temp_" + Date.now().toString(36);
    var password = generatePassword();
    els.newUsernameInput.value = username;
    els.newPasswordInput.value = password;
    els.newRoleSelect.value = "worker";
    await runBusy("임시 계정 생성 중", async function () {
      await requestJson("/api/admin/users", {
        method: "POST",
        body: { username: username, password: password, role: "worker" }
      });
      els.tempCredentialOutput.hidden = false;
      els.tempCredentialOutput.innerHTML = "<strong>임시 계정</strong><br>아이디: " + escapeHtml(username) + "<br>비밀번호: " + escapeHtml(password);
      setStatus("임시 작업자 계정을 생성했습니다.", "ok");
      await refreshAdmin();
    });
  }

  async function setUserActive(username, active) {
    if (!username) {
      return;
    }
    await runBusy(active ? "작업자 활성화 중" : "작업자 비활성화 중", async function () {
      await requestJson("/api/admin/users/active", {
        method: "POST",
        body: { username: username, active: active }
      });
      setStatus(active ? "작업자를 활성화했습니다." : "작업자를 비활성화했습니다.", "ok");
      await refreshAll();
    });
  }

  async function removeUser(username) {
    if (!username) {
      return;
    }
    if (!window.confirm("작업자를 삭제할까요? 해당 작업자의 배정 정보도 함께 삭제됩니다.")) {
      return;
    }
    await runBusy("작업자 삭제 중", async function () {
      await requestJson("/api/admin/users/remove", {
        method: "POST",
        body: { username: username }
      });
      setStatus("작업자를 삭제했습니다.", "ok");
      await refreshAll();
    });
  }

  async function saveProjectFromModal() {
    var name = els.projectNameInput.value.trim();
    var labels = serializeProjectLabels();
    var folderPaths = state.folderBrowser.selectedFolders.slice();
    var currentFolderPath = (state.folderBrowser.currentPath || els.folderPathInput.value || "").trim();
    var wasEditing = Boolean(state.editingProjectId);
    if (!folderPaths.length && currentFolderPath) {
      folderPaths.push(currentFolderPath);
    }
    if (!name) {
      setStatus("프로젝트 이름을 입력하세요.", "error");
      return;
    }
    if (!labels.length) {
      setStatus("라벨을 하나 이상 추가하세요.", "error");
      return;
    }
    await runBusy(wasEditing ? "프로젝트 수정 중" : "프로젝트 생성 중", async function () {
      var projectId = state.editingProjectId;
      if (projectId) {
        await requestJson("/api/admin/projects/update", {
          method: "POST",
          body: { project_id: projectId, name: name, labels: labels }
        });
      } else {
        var data = await requestJson("/api/admin/projects", { method: "POST", body: { name: name, labels: labels } });
        projectId = data.project && data.project.id;
      }
      var addedCount = 0;
      if (projectId) {
        for (var i = 0; i < folderPaths.length; i += 1) {
          var folderData = await requestJson("/api/admin/projects/folders", {
            method: "POST",
            body: { project_id: projectId, path: folderPaths[i] }
          });
          addedCount += folderData.count || 0;
        }
      }
      els.projectNameInput.value = "";
      state.editingProjectId = "";
      state.projectLabels = defaultProjectLabels();
      if (els.projectLabelColorInput) {
        els.projectLabelColorInput.value = nextAvailableLabelColor(state.projectLabels);
      }
      state.folderBrowser.selectedFolders = [];
      renderProjectLabelEditor();
      renderSelectedFolders();
      closeProjectModal();
      if (wasEditing) {
        setStatus(addedCount ? "프로젝트를 수정하고 YOLO 폴더 " + addedCount + "개를 추가했습니다." : "프로젝트를 수정했습니다.", "ok");
      } else {
        setStatus(addedCount ? "프로젝트와 YOLO 폴더 " + addedCount + "개를 생성했습니다." : "프로젝트를 생성했습니다.", "ok");
      }
      await refreshAdmin();
    });
  }

  async function removeProjectById(projectId) {
    if (!window.confirm("프로젝트 설정을 삭제할까요? 실제 이미지와 라벨 파일은 삭제되지 않습니다.")) {
      return;
    }
    await runBusy("프로젝트 삭제 중", async function () {
      await requestJson("/api/admin/projects/remove", { method: "POST", body: { project_id: projectId } });
      await refreshAll();
    });
  }

  async function removeFolderById(projectId, folderId) {
    if (!window.confirm("YOLO 폴더 등록과 관련 배정을 삭제할까요? 실제 파일은 삭제되지 않습니다.")) {
      return;
    }
    await runBusy("YOLO 폴더 삭제 중", async function () {
      await requestJson("/api/admin/projects/folders/remove", { method: "POST", body: { project_id: projectId, folder_id: folderId } });
      await refreshAll();
    });
  }

  async function saveFolderAssignments() {
    var username = els.assignmentUserSelect.value;
    var projectId = els.assignmentProjectSelect.value;
    var project = selectedAssignmentProject();
    var visibleFolderIds = visibleAssignmentFolders(project).map(function (folder) { return folder.id; });
    var checkedFolderIds = Array.prototype.slice.call(els.assignmentFolderChecklist.querySelectorAll("input[type='checkbox']:checked"))
      .filter(function (input) { return !input.disabled; })
      .map(function (input) { return input.value; });
    var assigned = project && project.assignments && project.assignments[username] ? project.assignments[username] : [];
    var folderIds = assigned.filter(function (folderId) {
      return visibleFolderIds.indexOf(folderId) < 0;
    });
    checkedFolderIds.forEach(function (folderId) {
      if (folderIds.indexOf(folderId) < 0) {
        folderIds.push(folderId);
      }
    });
    if (!username || !projectId) {
      setStatus("사용자와 프로젝트를 선택하세요.", "error");
      return;
    }
    await runBusy("작업자 배정 저장 중", async function () {
      await requestJson("/api/admin/assignments/bulk", {
        method: "POST",
        body: { username: username, project_id: projectId, folder_ids: folderIds }
      });
      setStatus("선택한 YOLO 폴더 배정을 저장했습니다.", "ok");
      await refreshAll();
    });
  }

  async function requestJson(url, options) {
    var init = options || {};
    var headers = { Accept: "application/json" };
    if (!init.skipAuth && state.token) {
      headers.Authorization = "Bearer " + state.token;
    }
    var fetchOptions = { method: init.method || "GET", headers: headers };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(init.body);
    }
    var response = await fetch(url, fetchOptions);
    var text = await response.text();
    var data = text ? parseJson(text) : null;
    if (!response.ok) {
      throw new Error(extractErrorMessage(data, response));
    }
    return data;
  }

  function renderAuth() {
    var loggedIn = Boolean(state.user);
    var isAdmin = loggedIn && state.user.role === "admin";
    els.loginPanel.hidden = loggedIn;
    els.appPanel.hidden = !loggedIn;
    els.workerPanel.hidden = !loggedIn || isAdmin;
    els.adminPanel.hidden = !loggedIn || !isAdmin;
    document.body.classList.toggle("worker-mode", loggedIn && !isAdmin);
    document.body.classList.toggle("admin-mode", loggedIn && isAdmin);
    if (els.checkpointSummary) {
      els.checkpointSummary.hidden = !loggedIn || isAdmin;
    }
    if (!loggedIn) {
      return;
    }
    els.currentUserSummary.textContent = state.user.username + " (" + roleName(state.user.role) + ")";
    if (isAdmin) {
      renderAdmin();
    } else {
      renderAssignedFolders();
      renderWorkerImageSummary();
      renderAnnotationList();
      renderAnnotationOverlay();
    }
    renderButtons();
  }

  function renderClaim() {
    var image = state.claim && state.claim.image ? state.claim.image : null;
    var hasClaim = Boolean(image);
    els.claimSummary.textContent = hasClaim ? state.claim.claim_id : "없음";
    els.projectSummary.textContent = image ? image.project_name + " / " + image.folder_name : "-";
    els.expiresSummary.textContent = hasClaim ? formatDateTime(state.claim.expires_at) : "-";
    els.filenameSummary.textContent = image ? image.relative_path || image.filename : "-";
    els.imageStatusSummary.textContent = image ? statusForImage(image) : "-";
    if (image) {
      els.imageLoadingState.hidden = true;
      els.claimedImage.fetchPriority = "high";
      els.claimedImage.decoding = "async";
      els.claimedImage.src = authenticatedImageUrl(image);
      els.claimedImage.hidden = false;
      els.emptyState.hidden = true;
    } else {
      els.imageLoadingState.hidden = true;
      els.claimedImage.removeAttribute("src");
      els.claimedImage.hidden = true;
      els.emptyState.hidden = false;
    }
    renderLabelOptions();
    renderButtons();
  }

  function authenticatedImageUrl(image) {
    if (!image || !image.url) {
      return "";
    }
    var separator = image.url.indexOf("?") >= 0 ? "&" : "?";
    return image.url + separator + "token=" + encodeURIComponent(state.token || "");
  }

  function renderLabelOptions() {
    var labels = labelsForCurrentClaim();
    if (!labels.length) {
      els.labelInput.innerHTML = '<option value="">라벨 없음</option>';
      els.quickLabels.innerHTML = "";
      return;
    }
    els.labelInput.innerHTML = labels.map(function (label) {
      return '<option value="' + escapeAttribute(label.id) + '">' + escapeHtml(label.id + " - " + label.name) + "</option>";
    }).join("");
    els.quickLabels.innerHTML = labels.map(function (label) {
      var color = normalizeLabelColor(label.color, label.id);
      return '<button class="quick-label" type="button" data-label-id="' + escapeAttribute(label.id) + '" style="--label-color: ' + escapeAttribute(color) + ';">' + escapeHtml(label.name) + "</button>";
    }).join("");
    renderQuickLabels();
  }

  function labelsForCurrentClaim() {
    if (state.claim && Array.isArray(state.claim.labels) && state.claim.labels.length) {
      return state.claim.labels.map(normalizeProjectLabel).filter(function (label) { return label.name; });
    }
    if (!state.claim || !state.claim.image) {
      return [];
    }
    var project = (state.worker.projects || []).find(function (item) {
      return item.id === state.claim.image.project_id;
    });
    return project && Array.isArray(project.labels) ? project.labels.map(normalizeProjectLabel).filter(function (label) { return label.name; }) : [];
  }

  function renderQuickLabels() {
    var value = String(els.labelInput.value);
    Array.prototype.slice.call(els.quickLabels.querySelectorAll(".quick-label")).forEach(function (button) {
      button.classList.toggle("active", button.dataset.labelId === value);
    });
  }

  function renderStats() {
    var stats = state.stats || {};
    var images = stats.images || {};
    var claims = stats.claims || {};
    var entries = [
      ["이미지", numberOrDash(images.total)],
      ["완료", numberOrDash(images.labeled)],
      ["가능", numberOrDash(images.available)],
      ["작업 중", numberOrDash(claims.active)],
      ["완료 claim", numberOrDash(claims.completed)],
      ["TTL", stats.claim_ttl_seconds ? stats.claim_ttl_seconds + "초" : "-"]
    ];
    els.statsGrid.innerHTML = entries.map(function (entry) {
      return '<div class="stat-cell"><span>' + escapeHtml(entry[0]) + '</span><strong>' + escapeHtml(formatValue(entry[1])) + '</strong></div>';
    }).join("");
  }

  function renderImages() {
    var images = state.images || [];
    els.listSummary.textContent = images.length ? images.length + "개 이미지" : "배정된 이미지가 없습니다.";
    if (!images.length) {
      els.imageListBody.innerHTML = '<tr><td colspan="4" class="table-empty">관리자가 프로젝트와 YOLO 폴더를 배정하면 표시됩니다.</td></tr>';
      return;
    }
    var currentId = state.claim && state.claim.image ? state.claim.image.id : "";
    els.imageListBody.innerHTML = images.map(function (image) {
      return '<tr class="' + (image.id === currentId ? "current-row" : "") + '">' +
        "<td>" + escapeHtml(image.project_name) + "</td>" +
        "<td>" + escapeHtml(image.folder_name) + "</td>" +
        "<td>" + escapeHtml(image.relative_path || image.filename) + "</td>" +
        "<td>" + escapeHtml(statusForImage(image)) + "</td>" +
        "</tr>";
    }).join("");
  }

  function renderFolderBrowser() {
    var browser = state.folderBrowser;
    els.folderPathInput.value = browser.currentPath;
    els.folderCurrentPath.textContent = browser.currentPath || "서버 로컬 루트";
    els.folderUpButton.disabled = state.busy || !browser.parentPath;
    els.selectCurrentFolderButton.disabled = state.busy || !browser.currentPath;
    if (!browser.entries.length) {
      els.folderBrowserList.innerHTML = '<div class="table-empty">표시할 하위 폴더가 없습니다.</div>';
      return;
    }
    els.folderBrowserList.innerHTML = browser.entries.map(function (entry) {
      var status = entry.is_yolo_root ? "YOLO 폴더" : (entry.has_yolo_children ? "하위 YOLO 폴더 포함" : "일반 폴더");
      var statusClass = entry.is_yolo_root || entry.has_yolo_children ? "ok" : "";
      return '<div class="folder-row">' +
        '<button class="folder-open" type="button" data-open-folder="' + escapeAttribute(entry.path) + '">' +
        '<strong>' + escapeHtml(entry.name) + '</strong><span>' + escapeHtml(entry.path) + '</span></button>' +
        '<span class="folder-badge ' + statusClass + '">' + escapeHtml(status) + '</span>' +
        '<button class="button secondary compact" type="button" data-select-folder="' + escapeAttribute(entry.path) + '">선택</button>' +
        '</div>';
    }).join("");
  }

  function renderSelectedFolders() {
    var selected = state.folderBrowser.selectedFolders || [];
    if (!selected.length) {
      els.selectedFolderList.innerHTML = '<div class="table-empty">선택된 접근 폴더가 없습니다.</div>';
      return;
    }
    els.selectedFolderList.innerHTML = selected.map(function (path) {
      return '<span class="selected-folder-chip">' + escapeHtml(path) +
        ' <button type="button" data-remove-selected-folder="' + escapeAttribute(path) + '">삭제</button></span>';
    }).join("");
  }

  function renderProjectLabelEditor() {
    state.projectLabels = state.projectLabels.map(normalizeProjectLabel).filter(function (label) { return label.name; });
    els.projectLabelsInput.value = state.projectLabels.map(function (label) { return label.name; }).join("\n");
    if (!state.projectLabels.length) {
      els.projectLabelList.innerHTML = '<div class="table-empty">추가된 라벨이 없습니다.</div>';
      return;
    }
    els.projectLabelList.innerHTML = state.projectLabels.map(function (label, index) {
      var color = normalizeLabelColor(label.color, index);
      return '<span class="label-editor-chip">' +
        '<input class="label-chip-color" type="color" value="' + escapeAttribute(color) + '" data-project-label-color="' + escapeAttribute(index) + '" aria-label="' + escapeAttribute(label.name + " 색상") + '">' +
        '<strong style="--label-color: ' + escapeAttribute(color) + ';">' + escapeHtml(index) + '</strong>' +
        '<span>' + escapeHtml(label.name) + '</span>' +
        '<button type="button" data-remove-project-label="' + escapeAttribute(index) + '">삭제</button>' +
        '</span>';
    }).join("");
  }

  function renderAdmin() {
    renderAdminTabs();
    renderAdminSelects();
    renderProjectList();
    renderProgressProjectSelect();
    renderProgressView();
    renderWorkerList();
    renderUserAssignments();
    renderSelectedFolders();
    renderButtons();
  }

  function renderAdminTabs() {
    var tab = state.adminActiveTab || "projects";
    var meta = {
      projects: ["프로젝트", "프로젝트 목록과 접근 폴더를 관리합니다."],
      workers: ["작업자", "작업자 계정을 생성하고 목록을 확인합니다."],
      assignments: ["할당", "작업자별로 작업할 YOLO 폴더를 배정합니다."],
      progress: ["진행상황", "프로젝트별 라벨링 진행 상황을 확인합니다."]
    };
    [els.adminProjectsTab, els.adminWorkersTab, els.adminAssignmentsTab, els.adminProgressTab].forEach(function (button) {
      button.classList.toggle("active", button.dataset.adminTab === tab);
    });
    els.adminProjectsView.hidden = tab !== "projects";
    els.adminWorkersView.hidden = tab !== "workers";
    els.adminAssignmentsView.hidden = tab !== "assignments";
    els.adminProgressView.hidden = tab !== "progress";
    els.openProjectModalButton.hidden = tab !== "projects";
    els.adminViewTitle.textContent = meta[tab][0];
    els.adminViewDescription.textContent = meta[tab][1];
  }

  function renderAdminSelects() {
    var projects = state.admin.projects || [];
    var users = (state.admin.users || []).filter(function (user) { return user.role === "worker"; });
    var currentUser = els.assignmentUserSelect.value;
    var currentProject = els.assignmentProjectSelect.value;
    els.assignmentUserSelect.innerHTML = users.length
      ? users.map(function (user) {
        var suffix = user.active === false ? " (비활성)" : "";
        return '<option value="' + escapeAttribute(user.username) + '">' + escapeHtml(user.username + suffix) + "</option>";
      }).join("")
      : '<option value="">작업자 없음</option>';
    els.assignmentProjectSelect.innerHTML = projects.length
      ? projects.map(function (project) { return '<option value="' + escapeAttribute(project.id) + '">' + escapeHtml(project.name) + "</option>"; }).join("")
      : '<option value="">프로젝트 없음</option>';
    if (users.some(function (user) { return user.username === currentUser; })) {
      els.assignmentUserSelect.value = currentUser;
    }
    if (projects.some(function (project) { return project.id === currentProject; })) {
      els.assignmentProjectSelect.value = currentProject;
    }
    renderAssignmentChecklist();
  }

  function selectedAssignmentProject() {
    var projectId = els.assignmentProjectSelect.value;
    return (state.admin.projects || []).find(function (item) { return item.id === projectId; });
  }

  function renderAssignmentChecklist() {
    if (!els.assignmentFolderChecklist) {
      return;
    }
    var username = els.assignmentUserSelect.value;
    var project = selectedAssignmentProject();
    if (!project) {
      els.assignmentFolderChecklist.innerHTML = '<div class="table-empty">프로젝트를 선택하세요.</div>';
      return;
    }
    var assigned = project.assignments && project.assignments[username] ? project.assignments[username] : [];
    var folders = project.folders || [];
    var takenByFolder = assignmentsByFolder(project);
    if (!folders.length) {
      els.assignmentFolderChecklist.innerHTML = '<div class="table-empty">등록된 YOLO 폴더가 없습니다.</div>';
      return;
    }
    var controls = '<div class="checklist-actions">' +
      '<button class="button secondary compact" type="button" data-assignment-select-all="1">전체 선택</button>' +
      '<button class="button secondary compact" type="button" data-assignment-clear-all="1">전체 해제</button>' +
      '</div>';
    var rows = folders.map(function (folder) {
      var checked = assigned.indexOf(folder.id) >= 0 ? " checked" : "";
      var takenByOthers = (takenByFolder[folder.id] || []).filter(function (assignedUsername) {
        return assignedUsername !== username;
      });
      var disabled = takenByOthers.length ? " disabled" : "";
      var rowClass = takenByOthers.length ? " check-row-disabled" : "";
      var takenText = takenByOthers.length ? " · 배정됨: " + takenByOthers.join(", ") : "";
      return '<label class="check-row' + rowClass + '">' +
        '<input type="checkbox" value="' + escapeAttribute(folder.id) + '"' + checked + disabled + '>' +
        '<span><strong>' + escapeHtml(folder.name) + '</strong><span class="muted"> ' + escapeHtml(folder.labeled + "/" + folder.total + " 완료, 가능 " + folder.available + takenText) + '</span></span>' +
        '</label>';
    }).join("");
    els.assignmentFolderChecklist.innerHTML = controls + rows;
  }

  function visibleAssignmentFolders(project) {
    return project && Array.isArray(project.folders) ? project.folders : [];
  }

  function setAssignmentChecklistChecked(checked) {
    Array.prototype.slice.call(els.assignmentFolderChecklist.querySelectorAll("input[type='checkbox']")).forEach(function (input) {
      if (!input.disabled) {
        input.checked = checked;
      }
    });
  }

  function renderProjectList() {
    var projects = state.admin.projects || [];
    if (!projects.length) {
      els.projectList.innerHTML = '<div class="table-empty">프로젝트가 없습니다.</div>';
      return;
    }
    els.projectList.innerHTML = projects.map(function (project) {
      var labels = renderProjectLabelSummary(project.labels || []);
      var summary = projectSummary(project);
      return '<section class="project-card">' +
        '<div class="list-header"><div><div class="panel-title">' + escapeHtml(project.name) + '</div><div class="project-labels"><span class="muted">라벨:</span> ' + labels + '</div></div>' +
        '<div class="project-actions">' +
        '<button class="button secondary compact" data-edit-project="' + escapeAttribute(project.id) + '">프로젝트 수정</button>' +
        '<button class="button danger compact" data-remove-project="' + escapeAttribute(project.id) + '">프로젝트 삭제</button>' +
        '</div></div>' +
        '<div class="project-summary-grid">' +
        summary.metrics.map(function (item) {
          return '<div class="summary-metric"><span>' + escapeHtml(item.label) + '</span><strong>' + escapeHtml(item.value) + '</strong></div>';
        }).join("") +
        '<div class="summary-metric wide"><span>배정</span><strong>' + summary.assignments + '</strong></div>' +
        '</div>' +
        "</section>";
    }).join("");
  }

  function renderProjectLabelSummary(labels) {
    var normalized = (labels || []).map(normalizeProjectLabel).filter(function (label) { return label.name; });
    if (!normalized.length) {
      return '<span class="muted">없음</span>';
    }
    return normalized.map(function (label) {
      var color = normalizeLabelColor(label.color, label.id);
      return '<span class="project-label-chip" style="--label-color: ' + escapeAttribute(color) + ';">' +
        '<strong>' + escapeHtml(label.id) + '</strong>' +
        '<span>' + escapeHtml(label.name) + '</span>' +
        '</span>';
    }).join("");
  }

  function projectSummary(project) {
    var folders = project.folders || [];
    var totalImages = folders.reduce(function (sum, folder) { return sum + (Number(folder.total) || 0); }, 0);
    var availableImages = folders.reduce(function (sum, folder) { return sum + (Number(folder.available) || 0); }, 0);
    var completedFolders = folders.filter(isFolderDone);
    var reviewFolders = folders.filter(isFolderReview);
    var completedImages = completedFolders.reduce(function (sum, folder) { return sum + (Number(folder.total) || 0); }, 0);
    var reviewImages = reviewFolders.reduce(function (sum, folder) { return sum + (Number(folder.total) || 0); }, 0);
    return {
      metrics: [
        { label: "YOLO 폴더", value: folders.length + "개" },
        { label: "완료 폴더", value: completedFolders.length + "/" + folders.length },
        { label: "완료 이미지", value: completedImages + "/" + totalImages },
        { label: "검수 폴더", value: reviewFolders.length + "/" + folders.length },
        { label: "검수 이미지", value: reviewImages + "/" + totalImages },
        { label: "작업 가능", value: availableImages + "개" }
      ],
      assignments: projectAssignmentSummary(project)
    };
  }

  function folderMark(folder) {
    return folder && folder.mark && typeof folder.mark === "object" ? folder.mark : {};
  }

  function folderMarkStatus(folder) {
    return String(folderMark(folder).status || "").trim();
  }

  function isFolderDone(folder) {
    return folderMarkStatus(folder) === "done";
  }

  function isFolderReview(folder) {
    return folderMarkStatus(folder) === "review";
  }

  function folderProgressText(folder) {
    var status = folderMarkStatus(folder);
    if (status === "done" || status === "review") {
      return folderMarkStatusText(status);
    }
    return folderCheckpointText(folder.checkpoint || {}, folder.total);
  }

  function folderProgressHtml(folder) {
    var status = folderMarkStatus(folder);
    if (status === "done" || status === "review") {
      return '<span class="status-pill ' + escapeAttribute(status) + '">' + escapeHtml(folderMarkStatusText(status)) + '</span>';
    }
    return '<span class="muted">' + escapeHtml(folderProgressText(folder)) + '</span>';
  }

  function projectAssignmentSummary(project) {
    var assignments = project.assignments || {};
    var parts = Object.keys(assignments).filter(function (username) {
      return Array.isArray(assignments[username]) && assignments[username].length;
    }).sort().map(function (username) {
      return username + " " + assignments[username].length + "개";
    });
    return parts.length ? escapeHtml(parts.join(", ")) : '<span class="muted">없음</span>';
  }

  function renderProgressProjectSelect() {
    var projects = state.admin.projects || [];
    var current = els.progressProjectSelect.value;
    els.progressProjectSelect.innerHTML = projects.length
      ? projects.map(function (project) { return '<option value="' + escapeAttribute(project.id) + '">' + escapeHtml(project.name) + "</option>"; }).join("")
      : '<option value="">프로젝트 없음</option>';
    if (projects.some(function (project) { return project.id === current; })) {
      els.progressProjectSelect.value = current;
    }
  }

  function renderProgressView() {
    if (!els.progressSummaryGrid || !els.progressFolderBody) {
      return;
    }
    var projectId = els.progressProjectSelect.value;
    var project = (state.admin.projects || []).find(function (item) { return item.id === projectId; });
    if (!project) {
      els.progressSummaryGrid.innerHTML = "";
      els.progressFolderBody.innerHTML = '<tr><td colspan="5" class="table-empty">프로젝트를 선택하세요.</td></tr>';
      return;
    }
    var summary = projectSummary(project);
    els.progressSummaryGrid.innerHTML = summary.metrics.map(function (item) {
      return '<div class="summary-metric"><span>' + escapeHtml(item.label) + '</span><strong>' + escapeHtml(item.value) + '</strong></div>';
    }).join("") + '<div class="summary-metric"><span>배정 작업자</span><strong>' + escapeHtml(assignedWorkerCount(project) + "명") + '</strong></div>';

    var folders = project.folders || [];
    if (!folders.length) {
      els.progressFolderBody.innerHTML = '<tr><td colspan="5" class="table-empty">등록된 YOLO 폴더가 없습니다.</td></tr>';
      return;
    }
    var folderAssignments = assignmentsByFolder(project);
    els.progressFolderBody.innerHTML = folders.map(function (folder) {
      var assigned = folderAssignments[folder.id] || [];
      return "<tr>" +
        "<td><strong>" + escapeHtml(folder.name) + "</strong><div class=\"muted\">" + escapeHtml(folder.root_path || "") + "</div></td>" +
        "<td>" + folderProgressHtml(folder) + "</td>" +
        "<td>" + escapeHtml(Number(folder.available) || 0) + "</td>" +
        "<td>" + escapeHtml(Number(folder.claimed) || 0) + "</td>" +
        "<td>" + (assigned.length ? escapeHtml(assigned.join(", ")) : '<span class="muted">없음</span>') + "</td>" +
        "</tr>";
    }).join("");
  }

  function assignmentsByFolder(project) {
    var result = {};
    Object.keys(project.assignments || {}).forEach(function (username) {
      var folderIds = project.assignments[username] || [];
      folderIds.forEach(function (folderId) {
        if (!result[folderId]) {
          result[folderId] = [];
        }
        result[folderId].push(username);
      });
    });
    return result;
  }

  function assignedWorkerCount(project) {
    return Object.keys(project.assignments || {}).filter(function (username) {
      return Array.isArray(project.assignments[username]) && project.assignments[username].length;
    }).length;
  }

  function renderWorkerList() {
    var workers = (state.admin.users || []).filter(function (user) { return user.role === "worker"; });
    var rows = workers.map(function (user) {
      var active = user.active !== false;
      var activeLabel = active ? "활성" : "비활성";
      var toggleLabel = active ? "비활성화" : "활성화";
      var toggleClass = active ? "danger" : "success";
      return "<tr>" +
        "<td><strong>" + escapeHtml(user.username) + "</strong></td>" +
        '<td><span class="status-pill ' + (active ? "active" : "inactive") + '">' + escapeHtml(activeLabel) + "</span></td>" +
        "<td>" + escapeHtml(assignmentsForUser(user.username).length + "개") + "</td>" +
        "<td>" + escapeHtml(formatDateTime(user.created_at)) + "</td>" +
        '<td><div class="table-actions">' +
        '<button class="button ' + toggleClass + ' compact" type="button" data-user-active="' + escapeAttribute(!active) + '" data-username="' + escapeAttribute(user.username) + '">' + escapeHtml(toggleLabel) + "</button>" +
        '<button class="button danger compact" type="button" data-remove-user="' + escapeAttribute(user.username) + '">삭제</button>' +
        "</div></td>" +
        "</tr>";
    });
    els.workerListBody.innerHTML = rows.length ? rows.join("") : '<tr><td colspan="5" class="table-empty">작업자가 없습니다.</td></tr>';
  }

  function renderUserAssignments() {
    var users = (state.admin.users || []).filter(function (user) { return user.role === "worker"; });
    var rows = users.map(function (user) {
      var summaries = assignmentSummariesForUser(user.username);
      var totalCount = summaries.reduce(function (sum, item) { return sum + item.count; }, 0);
      var html = summaries.length ? summaries.map(function (item) {
        return '<span class="assignment-chip assignment-summary-chip">' +
          '<strong>' + escapeHtml(item.projectName) + '</strong>' +
          '<span>' + escapeHtml(item.count + "개") + '</span>' +
          '</span>';
      }).join(" ") : '<span class="muted">없음</span>';
      return "<tr>" +
        "<td>" + escapeHtml(user.username) + "</td>" +
        "<td>" + html + "</td>" +
        "<td>" + escapeHtml(totalCount + "개") + "</td>" +
        "</tr>";
    });
    els.userAssignmentBody.innerHTML = rows.length ? rows.join("") : '<tr><td colspan="3" class="table-empty">작업자가 없습니다.</td></tr>';
  }

  function assignmentSummariesForUser(username) {
    var results = [];
    (state.admin.projects || []).forEach(function (project) {
      var folderIds = project.assignments && project.assignments[username] ? project.assignments[username] : [];
      if (!folderIds.length) {
        return;
      }
      results.push({
        projectId: project.id,
        projectName: project.name,
        count: folderIds.length
      });
    });
    return results;
  }

  function assignmentsForUser(username) {
    var results = [];
    (state.admin.projects || []).forEach(function (project) {
      var folderIds = project.assignments && project.assignments[username] ? project.assignments[username] : [];
      folderIds.forEach(function (folderId) {
        var folder = (project.folders || []).find(function (item) { return item.id === folderId; });
        results.push({
          projectId: project.id,
          projectName: project.name,
          folderId: folderId,
          folderName: folder ? folder.name : folderId
        });
      });
    });
    return results;
  }

  function renderButtons() {
    var hasClaim = Boolean(state.claim && state.claim.claim_id);
    var isAdmin = state.user && state.user.role === "admin";
    var hasImage = Boolean(currentImage());
    var hasLoadedImage = hasImage && state.imageLoad.imageReady && state.imageLoad.annotationsReady;
    [els.refreshButton, els.refreshImagesButton, els.logoutButton].forEach(disableIfBusy);
    els.claimButton.disabled = state.busy || !assignedWorkerFolders().length;
    els.openFolderPickerButton.disabled = state.busy || !assignedWorkerFolders().length;
    els.closeFolderPickerButton.disabled = state.busy;
    renderToolbarFolderMarkActions();
    Array.prototype.slice.call(els.assignedFolderList.querySelectorAll("[data-open-folder], [data-folder-mark]")).forEach(function (button) {
      button.disabled = state.busy;
    });
    els.saveButton.disabled = state.busy || !hasClaim;
    els.releaseButton.disabled = state.busy || !hasClaim;
    els.prevImageButton.disabled = state.busy || state.currentImageIndex <= 0;
    els.nextImageButton.disabled = state.busy || state.currentImageIndex < 0 || state.currentImageIndex >= state.images.length - 1;
    els.drawBoxButton.disabled = state.busy || !hasLoadedImage;
    els.drawBoxButton.classList.toggle("active", state.drawMode);
    els.imageStage.classList.toggle("drawing", state.drawMode);
    els.saveAnnotationsButton.disabled = state.busy || !hasLoadedImage || !state.annotationsDirty;
    if (isAdmin) {
      [
        els.adminRefreshButton, els.openProjectModalButton, els.createUserButton, els.createTempUserButton,
        els.createProjectButton, els.addProjectLabelButton, els.saveAssignmentButton, els.browseFolderPathButton,
        els.selectCurrentFolderButton, els.clearSelectedFoldersButton, els.closeProjectModalButton,
        els.cancelProjectModalButton
      ].forEach(disableIfBusy);
      els.folderUpButton.disabled = state.busy || !state.folderBrowser.parentPath;
      els.selectCurrentFolderButton.disabled = state.busy || !state.folderBrowser.currentPath;
    }
  }

  function disableIfBusy(button) {
    if (button) {
      button.disabled = state.busy;
    }
  }

  function getStoredClaim() {
    try {
      var raw = localStorage.getItem(CLAIM_KEY);
      var claim = raw ? JSON.parse(raw) : null;
      if (claim && claim.expires_at && new Date(claim.expires_at).getTime() <= Date.now()) {
        localStorage.removeItem(CLAIM_KEY);
        return null;
      }
      return claim;
    } catch (error) {
      localStorage.removeItem(CLAIM_KEY);
      return null;
    }
  }

  async function runBusy(message, task) {
    state.busy = true;
    renderButtons();
    setStatus(message + "...", "");
    try {
      await task();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      state.busy = false;
      renderButtons();
    }
  }

  function parseLines(value) {
    return value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  }

  function generatePassword() {
    return "pw-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("서버 응답 JSON을 해석하지 못했습니다.");
    }
  }

  function extractErrorMessage(data, response) {
    if (data && typeof data.message === "string") {
      return data.message;
    }
    if (data && data.error && typeof data.error.message === "string") {
      return data.error.message;
    }
    return "요청 실패: HTTP " + response.status;
  }

  function statusForImage(image) {
    if (image.labeled || image.status === "labeled") {
      return "완료";
    }
    if (image.claimed || image.status === "claimed") {
      return "작업 중";
    }
    return "대기";
  }

  function roleName(role) {
    return role === "admin" ? "관리자" : "작업자";
  }

  function setStatus(message, type) {
    els.statusMessage.textContent = message || "";
    els.statusMessage.classList.toggle("ok", type === "ok");
    els.statusMessage.classList.toggle("error", type === "error");
  }

  function setLoginMessage(message) {
    els.loginMessage.textContent = message || "계정 정보를 입력하세요.";
  }

  function formatDateTime(value) {
    if (!value) {
      return "-";
    }
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ko-KR");
  }

  function numberOrDash(value) {
    return value === undefined || value === null ? "-" : value;
  }

  function formatValue(value) {
    if (value === undefined || value === null || value === "") {
      return "-";
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  function closestElement(target, selector) {
    return target && typeof target.closest === "function" ? target.closest(selector) : null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clamp01(value) {
    return clamp(value, 0, 1);
  }

  function percent(value) {
    return Math.round(value * 1000) / 10 + "%";
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
