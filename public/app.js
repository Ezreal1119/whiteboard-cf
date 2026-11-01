const input = document.querySelector("#boardInput");
const copyButton = document.querySelector("#copyButton");
const clearButton = document.querySelector("#clearButton");
const characterCount = document.querySelector("#characterCount");
const saveState = document.querySelector("#saveState");
const syncLabel = document.querySelector("#syncLabel");
const timerValue = document.querySelector("#timerValue");
const timerRing = document.querySelector("#timerRing");
const toast = document.querySelector("#toast");

const apiUrl = "/api/board";
const ttlMilliseconds = 10 * 60 * 1000;
let expiresAt = 0;
let latestUpdatedAt = 0;
let dirty = false;
let saveTimer;
let toastTimer;

input.addEventListener("input", () => {
  dirty = true;
  updateCount();
  setSaveState("Waiting to save");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 650);
});

input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    clearTimeout(saveTimer);
    void save();
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand("copy");
    input.setSelectionRange(input.value.length, input.value.length);
  }
  showToast(input.value ? "Copied to clipboard" : "The board is empty");
});

clearButton.addEventListener("click", async () => {
  clearTimeout(saveTimer);
  dirty = false;
  input.value = "";
  updateCount();
  setSaveState("Clearing…");
  try {
    const response = await fetch(apiUrl, { method: "DELETE" });
    if (!response.ok) throw new Error("Could not clear the board.");
    expiresAt = 0;
    latestUpdatedAt = 0;
    setSaveState("Board cleared");
    showToast("Board cleared");
  } catch (error) {
    setSaveState(error.message, true);
  }
});

window.addEventListener("focus", () => void load());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void load();
});

async function load() {
  try {
    const response = await fetch(apiUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not connect");
    const data = await response.json();
    if (!dirty && data.updatedAt >= latestUpdatedAt) {
      input.value = data.text;
      latestUpdatedAt = data.updatedAt;
      expiresAt = data.expiresAt;
      updateCount();
    }
    setConnected(true);
    setSaveState(data.text ? "Synced across devices" : "Ready for something new");
  } catch {
    setConnected(false);
    setSaveState("Offline — changes will retry", true);
  }
}

async function save() {
  const text = input.value;
  setSaveState("Saving…");
  try {
    const response = await fetch(apiUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save the board.");
    dirty = false;
    latestUpdatedAt = data.updatedAt;
    expiresAt = data.expiresAt;
    setConnected(true);
    setSaveState(text ? "Saved just now" : "Board cleared");
  } catch (error) {
    dirty = true;
    setConnected(false);
    setSaveState(error.message, true);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 3000);
  }
}

function updateTimer() {
  const remaining = Math.max(0, expiresAt - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  timerValue.textContent = expiresAt ? `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : "10:00";
  timerRing.style.setProperty("--progress", `${remaining / ttlMilliseconds * 360}deg`);
  if (expiresAt && remaining === 0 && !dirty) {
    expiresAt = 0;
    latestUpdatedAt = 0;
    input.value = "";
    updateCount();
    setSaveState("Expired and cleared");
  }
}

function updateCount() {
  characterCount.textContent = input.value.length.toLocaleString();
  copyButton.disabled = !input.value;
  clearButton.disabled = !input.value;
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
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

updateCount();
updateTimer();
void load();
setInterval(updateTimer, 250);
setInterval(() => {
  if (!dirty) void load();
}, 4000);
