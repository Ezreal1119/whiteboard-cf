import { uploadFile as multipartUpload } from "/uploads.js";

const input = document.querySelector("#boardInput");
const copyButton = document.querySelector("#copyButton");
const clearButton = document.querySelector("#clearButton");
const characterCount = document.querySelector("#characterCount");
const saveState = document.querySelector("#saveState");
const syncLabel = document.querySelector("#syncLabel");
const timerValue = document.querySelector("#timerValue");
const timerRing = document.querySelector("#timerRing");
const toast = document.querySelector("#toast");
const fileInput = document.querySelector("#fileInput");
const uploadButton = document.querySelector("#uploadButton");
const cancelUploadButton = document.querySelector("#cancelUploadButton");
const dropZone = document.querySelector("#dropZone");
const fileList = document.querySelector("#fileList");
const fileSummary = document.querySelector("#fileSummary");
const uploadState = document.querySelector("#uploadState");

const DAY = 24 * 60 * 60 * 1000;
const MAX_FILE_SIZE = 3_000_000_000;
let expiresAt = 0;
let dirty = false;
let version = 0;
let epoch = 0;
let saving = null;
let loading = false;
let clearing = false;
let uploading = false;
let uploadController;
let storageUsage = null;
let files = [];
let fileSignature = "";
let saveTimer;
let toastTimer;

input.addEventListener("input", () => {
  dirty = true;
  version++;
  epoch++;
  updateCount();
  setSaveState("Waiting to save");
  queueSave(650);
});
input.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    clearTimeout(saveTimer);
    void save();
  }
});
copyButton.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(input.value); }
  catch {
    input.select();
    document.execCommand("copy");
    input.setSelectionRange(input.value.length, input.value.length);
  }
  showToast(input.value ? "Copied to clipboard" : "The board is empty");
});
clearButton.addEventListener("click", async () => {
  if (clearing || uploading) return;
  clearing = true;
  epoch++;
  clearTimeout(saveTimer);
  input.disabled = true;
  updateCount();
  setSaveState("Clearing…");
  try {
    // Finish any pending save before clearing so it cannot restore deleted text.
    if (saving) await saving;
    clearTimeout(saveTimer);
    const data = await api("/api/board", { method: "DELETE" });
    input.value = data.text;
    dirty = false;
    version++;
    expiresAt = 0;
    renderFiles(data.files, data.storage);
    setSaveState("Board cleared");
    showToast("Text and files cleared");
  } catch (error) { setSaveState(error.message, true); }
  finally {
    clearing = false;
    input.disabled = false;
    epoch++;
    updateCount();
    if (dirty) queueSave(650);
  }
});

uploadButton.addEventListener("click", () => fileInput.click());
cancelUploadButton.addEventListener("click", () => uploadController?.abort(new Error("Upload cancelled.")));
fileInput.addEventListener("change", () => {
  const selected = [...fileInput.files];
  fileInput.value = "";
  void uploadFiles(selected);
});
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}
dropZone.addEventListener("drop", event => void uploadFiles([...event.dataTransfer.files]));
document.addEventListener("paste", event => {
  const pasted = [...(event.clipboardData?.files || [])];
  if (pasted.length) {
    event.preventDefault();
    void uploadFiles(pasted);
  }
});
window.addEventListener("focus", () => void load());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void load();
});

async function api(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  let data;
  try { data = await response.json(); }
  catch { throw new Error("Unexpected server response. Please try again."); }
  if (!response.ok) throw new Error(data.error || "Could not connect. Please try again.");
  return data;
}

async function load() {
  if (loading || clearing) return;
  loading = true;
  const startedAt = epoch;
  try {
    const data = await api("/api/board");
    if (startedAt !== epoch || clearing) return;
    if (!dirty && !saving) {
      input.value = data.text;
      expiresAt = data.text ? data.expiresAt : 0;
      updateCount();
      setSaveState(data.text ? "Synced across devices" : "Ready for something new");
    }
    renderFiles(data.files, data.storage);
    setConnected(true);
  } catch {
    setConnected(false);
    if (!dirty && !saving) setSaveState("Offline — reconnecting…", true);
  } finally { loading = false; }
}

function queueSave(delay) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), delay);
}

async function save() {
  if (saving || clearing || !dirty) return;
  const savedVersion = version;
  const text = input.value;
  epoch++;
  setSaveState("Saving…");
  saving = (async () => {
    try {
      const data = await api("/api/board", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
      if (savedVersion === version) {
        dirty = false;
        expiresAt = text ? data.expiresAt : 0;
        setSaveState(text ? "Saved just now" : "Text cleared — files kept");
      }
      setConnected(true);
    } catch (error) {
      setConnected(false);
      setSaveState(error.message, true);
    }
  })();
  await saving;
  saving = null;
  epoch++;
  if (dirty && !clearing) queueSave(savedVersion === version ? 3000 : 0);
}

async function uploadFiles(selected) {
  if (!selected.length || uploading || clearing) return;
  uploading = true;
  uploadController = new AbortController();
  epoch++;
  updateCount();
  let succeeded = 0;
  const errors = [];
  for (const file of selected) {
    if (uploadController.signal.aborted) { errors.push("Upload cancelled."); break; }
    if (!file.size || file.size > MAX_FILE_SIZE) {
      errors.push(`${file.name}: choose a file between 1 byte and 3 GB.`);
      continue;
    }
    try {
      await uploadFile(file, uploadController.signal);
      succeeded++;
    } catch (error) { errors.push(`${file.name}: ${error.message}`); }
  }
  uploading = false;
  uploadController = null;
  epoch++;
  updateCount();
  uploadState.textContent = errors.length ? errors.join(" · ") : `${succeeded} file${succeeded === 1 ? "" : "s"} uploaded. Each expires in 3 days.`;
  uploadState.classList.toggle("is-error", Boolean(errors.length));
  if (succeeded) showToast(`${succeeded} file${succeeded === 1 ? "" : "s"} uploaded`);
  void load();
}

async function uploadFile(file, signal) {
  uploadState.classList.remove("is-error");
  return multipartUpload(file, {
    signal,
    onProgress: ({ loaded, total, part, parts }) => {
      uploadState.textContent = `Uploading ${file.name} · ${Math.round(loaded / total * 100)}% · Part ${part}/${parts}`;
    },
  });
}

function renderFiles(nextFiles = [], storage = null) {
  if (storage) storageUsage = storage;
  files = nextFiles.filter(file => file.expiresAt > Date.now());
  const signature = JSON.stringify([files, storageUsage]);
  if (signature === fileSignature) return;
  fileSignature = signature;
  fileList.replaceChildren();
  fileSummary.textContent = `${files.length}/20 files · ${formatSize(storageUsage?.usedBytes ?? files.reduce((total, file) => total + file.size, 0))} / 20 GB${storageUsage?.reservedBytes ? " (including uploads)" : ""}`;
  for (const file of files) {
    const card = document.createElement("article");
    card.className = "file-card";
    const link = document.createElement("a");
    link.className = "file-preview";
    link.href = `/api/files/${file.id}${file.previewable ? "" : "?download"}`;
    link.target = "_blank";
    link.rel = "noopener";
    if (file.previewable) {
      const img = document.createElement("img");
      img.src = `/api/files/${file.id}`;
      img.alt = file.name;
      img.loading = "lazy";
      link.append(img);
    } else {
      const label = document.createElement("span");
      label.className = "file-extension";
      label.textContent = file.name.split(".").pop().slice(0, 8).toUpperCase();
      link.append(label);
      link.setAttribute("aria-label", `Download ${file.name}`);
    }
    const name = document.createElement("strong");
    name.className = "file-name";
    name.textContent = file.name;
    name.title = file.name;
    const meta = document.createElement("p");
    meta.className = "file-meta";
    const remaining = document.createElement("span");
    remaining.dataset.expires = String(file.expiresAt);
    remaining.textContent = `${formatTime(file.expiresAt - Date.now())} left`;
    meta.append(`${formatSize(file.size)} · `, remaining);
    const actions = document.createElement("div");
    actions.className = "file-actions";
    const download = document.createElement("a");
    download.href = `/api/files/${file.id}?download`;
    download.textContent = "Download";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${file.name}`);
    remove.addEventListener("click", async () => {
      if (clearing) return;
      remove.disabled = true;
      epoch++;
      try {
        const data = await api(`/api/files/${file.id}`, { method: "DELETE" });
        renderFiles(data.files, data.storage);
        showToast("File deleted");
      } catch (error) { showToast(error.message); remove.disabled = false; }
      finally { epoch++; }
    });
    actions.append(download, remove);
    card.append(link, name, meta, actions);
    fileList.append(card);
  }
  updateCount();
}

function formatSize(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}
function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(part => String(part).padStart(2, "0")).join(":");
}
function updateTimer() {
  const remaining = Math.max(0, expiresAt - Date.now());
  timerValue.textContent = expiresAt ? formatTime(remaining) : "24:00:00";
  timerRing.style.setProperty("--progress", `${Math.min(1, remaining / DAY) * 360}deg`);
  if (expiresAt && remaining === 0 && !dirty && !saving) {
    expiresAt = 0;
    input.value = "";
    updateCount();
    setSaveState("Text expired and cleared");
  }
  if (files.some(file => file.expiresAt <= Date.now())) renderFiles(files);
  for (const label of fileList.querySelectorAll("[data-expires]")) label.textContent = `${formatTime(Number(label.dataset.expires) - Date.now())} left`;
}
function updateCount() {
  characterCount.textContent = input.value.length.toLocaleString();
  copyButton.disabled = !input.value || clearing;
  clearButton.disabled = clearing || uploading || (!input.value && !files.length);
  uploadButton.disabled = uploading || clearing;
  cancelUploadButton.hidden = !uploading;
  cancelUploadButton.disabled = Boolean(uploadController?.signal.aborted);
  dropZone.setAttribute("aria-busy", String(uploading));
}
function setConnected(connected) {
  syncLabel.textContent = connected ? "Live sync" : "Offline";
  document.querySelector(".live-state").classList.toggle("is-offline", !connected);
}
function setSaveState(message, isError = false) {
  saveState.textContent = message;
  saveState.classList.toggle("is-error", isError);
}
function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3000);
}
updateCount();
updateTimer();
void load();
setInterval(updateTimer, 1000);
setInterval(() => void load(), 4000);
