const STORAGE_KEY = "gpk-tiffin-menu-v1";
const DEFAULT_MENU = [
  { id: "dosa", name: "Dosa", items: [
    { id: "kal-dosa", name: "Kal Dosa", price: 20 },
    { id: "kal-nice", name: "Kal Nice", price: 30 },
    { id: "egg-kal", name: "Egg Kal", price: 40 },
    { id: "nice-dosa", name: "Nice Dosa", price: 40 },
    { id: "egg-dosa", name: "Egg Dosa", price: 60 },
    { id: "podi-dosa", name: "Podi Dosa", price: 60 },
    { id: "onion-dosa", name: "Onion Dosa", price: 70 },
    { id: "onion-uthapam", name: "Onion Uthapam", price: 50 },
    { id: "ghee-dosa", name: "Ghee Dosa", price: 70 },
    { id: "chicken-cari-dosa", name: "Chicken Cari Dosa", price: 150 },
    { id: "boti-dosa", name: "Boti Dosa", price: 150 }
  ] },
  { id: "parotta", name: "Parotta", items: [
    { id: "parotta", name: "Parotta", price: 20 },
    { id: "veechu", name: "Veechu", price: 40 },
    { id: "egg-veechu", name: "Egg Veechu", price: 60 },
    { id: "egg-kothu", name: "Egg Kothu", price: 100 },
    { id: "chicken-kothu", name: "Chicken Kothu", price: 150 },
    { id: "chicken-chapati-kothu", name: "Chicken Chapati Kothu", price: 150 },
    { id: "egg-chapati-kothu", name: "Egg Chapati Kothu", price: 100 },
    { id: "chicken-lappa", name: "Chicken Lappa", price: 150 },
    { id: "egg-lappa", name: "Egg Lappa", price: 100 }
  ] },
  { id: "Chicken", name: "Chicken", items: [
    { id: "chicken-liver", name: "Chicken Liver", price: 100 },
    { id: "chicken-boti", name: "Chicken Boti", price: 130 },
    { id: "chinnamani-chicken", name: "Chinnamani Chicken", price: 150 },
    { id: "pepper-chicken", name: "Pepper Chicken", price: 150 },
    { id: "chettinad-chicken", name: "Chettinad Chicken", price: 150 }
  ] }
];

const PAYMENT_DATABASE_NAME = "gpk-tiffin-payment-settings";
const PAYMENT_DATABASE_VERSION = 1;
const PAYMENT_STORE_NAME = "settings";
const PAYMENT_QR_MAX_BYTES = 5 * 1024 * 1024;
let menu = cloneMenu(DEFAULT_MENU);
let activeCategory = menu[0]?.id || "";
let currentBill = null;
let billRef = createBillReference();
let returnPage = 1;
let activeSettingsView = "home";
let priceDraftId = null;
let menuEdit = null;
let addItemFormOpen = false;
const cart = new Map();
let selectedSearchItemId = null;
let paymentDatabasePromise = null;
let paymentSettingsLoadPromise = null;
let paymentTransitionInProgress = false;
let paymentSettings = { upiId: "", qrBlob: null };
let paymentSettingsLoaded = false;
let paymentFormDirty = false;
let savedQrObjectUrl = null;
let draftQrObjectUrl = null;
let draftQrBlob = null;

const rupees = value => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", maximumFractionDigits: 2
}).format(value);

function cloneMenu(value) {
  return value.map(category => ({
    ...category,
    items: category.items.map(item => ({ ...item }))
  }));
}
function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function createBillReference() {
  return "GPK-" + Date.now().toString().slice(-8);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}
function allItems(source = menu) {
  return source.flatMap(category => category.items.map(item => ({ ...item, categoryId: category.id, category: category.name })));
}
function findCategory(categoryId, source = menu) {
  return source.find(category => category.id === categoryId);
}
function findItem(itemId, source = menu) {
  for (const category of source) {
    const item = category.items.find(entry => entry.id === itemId);
    if (item) return { item, category };
  }
  return null;
}
function currentTotal() {
  if (currentBill) return currentBill.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return allItems().reduce((sum, item) => sum + item.price * (cart.get(item.id) || 0), 0);
}
function openPaymentDatabase() {
  if (paymentDatabasePromise) return paymentDatabasePromise;
  paymentDatabasePromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support IndexedDB."));
      return;
    }
    const request = window.indexedDB.open(PAYMENT_DATABASE_NAME, PAYMENT_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PAYMENT_STORE_NAME)) {
        request.result.createObjectStore(PAYMENT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      paymentDatabasePromise = null;
      reject(request.error || new Error("Could not open payment settings storage."));
    };
    request.onblocked = () => {
      paymentDatabasePromise = null;
      reject(new Error("Payment settings storage is blocked by another open tab. Close other tabs and retry."));
    };
  }).catch(error => {
    paymentDatabasePromise = null;
    throw error;
  });
  return paymentDatabasePromise;
}
function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Payment settings could not be saved."));
    transaction.onabort = () => reject(transaction.error || new Error("Payment settings transaction was cancelled."));
  });
}
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not read payment settings."));
  });
}
async function readPaymentSettings() {
  const database = await openPaymentDatabase();
  const transaction = database.transaction(PAYMENT_STORE_NAME, "readonly");
  const done = transactionCompletion(transaction);
  const store = transaction.objectStore(PAYMENT_STORE_NAME);
  const [upiId, qrBlob] = await Promise.all([
    requestResult(store.get("upiId")),
    requestResult(store.get("qrCode"))
  ]);
  await done;
  return {
    upiId: typeof upiId === "string" ? upiId : "",
    qrBlob: qrBlob instanceof Blob ? qrBlob : null
  };
}
async function writePaymentSettings({ upiId, qrBlob, updateQr = false }) {
  const database = await openPaymentDatabase();
  const transaction = database.transaction(PAYMENT_STORE_NAME, "readwrite");
  const done = transactionCompletion(transaction);
  const store = transaction.objectStore(PAYMENT_STORE_NAME);
  store.put(upiId, "upiId");
  if (updateQr) {
    if (qrBlob) store.put(qrBlob, "qrCode");
    else store.delete("qrCode");
  }
  await done;
}
function isValidUpiId(value) {
  const parts = value.trim().split("@");
  return parts.length === 2 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(parts[0]) &&
    /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(parts[1]) &&
    /[A-Za-z0-9]$/.test(parts[1]);
}
async function validateQrImage(file) {
  if (!file || !["image/png", "image/jpeg"].includes(file.type)) {
    throw new Error("Choose a PNG, JPG, or JPEG image.");
  }
  if (file.size === 0 || file.size > PAYMENT_QR_MAX_BYTES) {
    throw new Error(file.size > PAYMENT_QR_MAX_BYTES
      ? "The QR image must be 5 MB or smaller."
      : "The selected image is empty.");
  }
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isPng = file.type === "image/png" &&
    header.length === 8 && header.join(",") === "137,80,78,71,13,10,26,10";
  const isJpeg = file.type === "image/jpeg" &&
    header.length >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255;
  if (!isPng && !isJpeg) throw new Error("The file content does not match a supported PNG or JPEG image.");
  if ("createImageBitmap" in window) {
    const image = await window.createImageBitmap(file);
    const valid = image.width > 0 && image.height > 0 && image.width <= 12000 && image.height <= 12000;
    image.close();
    if (!valid) throw new Error("The QR image dimensions are invalid or too large.");
  } else {
    const url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0
          ? resolve()
          : reject(new Error("The selected file is not a readable image."));
        image.onerror = () => reject(new Error("The selected file is not a readable image."));
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
function setSavedQrBlob(blob) {
  if (savedQrObjectUrl) URL.revokeObjectURL(savedQrObjectUrl);
  savedQrObjectUrl = blob ? URL.createObjectURL(blob) : null;
}
function clearDraftQr() {
  if (draftQrObjectUrl) URL.revokeObjectURL(draftQrObjectUrl);
  draftQrObjectUrl = null;
  draftQrBlob = null;
}
async function loadPaymentSettings() {
  try {
    paymentSettings = await readPaymentSettings();
    paymentSettingsLoaded = true;
    setSavedQrBlob(paymentSettings.qrBlob);
    if (activeSettingsView === "payment" && !paymentFormDirty) {
      document.getElementById("upi-id-input").value = paymentSettings.upiId;
    }
    renderPayment();
    renderSettingsViews();
  } catch (error) {
    console.error("Could not load saved payment settings.", error);
    paymentSettingsLoaded = true;
    if (activeSettingsView === "payment") {
      showSettingsMessage(`Could not load payment settings: ${error.message}`, "error");
    }
  }
}
async function waitForPaymentSettings() {
  if (paymentSettingsLoadPromise) await paymentSettingsLoadPromise;
  if (!paymentSettingsLoaded) throw new Error("Payment settings could not be loaded. Please refresh and retry.");
}
function refreshSettingsContinueButton() {
  const hasBill = Boolean(currentBill && currentBill.items.length && currentTotal() > 0);
  document.getElementById("settings-continue-payment").disabled = !hasBill;
}
async function persistPaymentSettings({ requireQr = false } = {}) {
  await waitForPaymentSettings();
  const upiId = document.getElementById("upi-id-input").value.trim();
  if (!upiId) throw new Error("Enter a UPI ID before saving payment settings.");
  if (!isValidUpiId(upiId)) throw new Error("Enter a valid UPI ID, for example yourname@upi.");
  const qrBlob = draftQrBlob || paymentSettings.qrBlob;
  if (requireQr && !qrBlob) throw new Error("Upload a QR image in Payment Settings before continuing to payment.");
  await writePaymentSettings({
    upiId,
    qrBlob,
    updateQr: Boolean(draftQrBlob)
  });
  paymentSettings = { upiId, qrBlob };
  paymentFormDirty = false;
  clearDraftQr();
  setSavedQrBlob(qrBlob);
  renderPayment();
  renderPaymentSettingsPreview();
  document.getElementById("qr-upload-status").textContent = "Payment settings saved.";
  showSettingsMessage("Payment settings saved successfully.", "success");
}
async function continueToPayment() {
  if (paymentTransitionInProgress) return false;
  paymentTransitionInProgress = true;
  const billButton = document.getElementById("to-payment");
  const settingsButton = document.getElementById("settings-continue-payment");
  billButton.disabled = true;
  settingsButton.disabled = true;
  try {
    if (!currentBill || !currentBill.items.length || currentTotal() <= 0) {
      const message = "Create a bill with at least one food item before continuing to payment.";
      if (!document.getElementById("settings-panel").hidden) showSettingsMessage(message, "error");
      else document.getElementById("payment-status").textContent = message;
      return false;
    }
    await waitForPaymentSettings();
    if (!document.getElementById("settings-panel").hidden &&
        activeSettingsView === "payment" && paymentFormDirty) {
      await persistPaymentSettings({ requireQr: true });
    } else {
      paymentSettings = await readPaymentSettings();
      setSavedQrBlob(paymentSettings.qrBlob);
    }
    if (!paymentSettings.upiId || !paymentSettings.qrBlob) {
      if (document.getElementById("settings-panel").hidden) showSettings();
      showSettingsView("payment");
      showSettingsMessage(
        "Configure and save both a valid UPI ID and a QR image before continuing to payment.",
        "error"
      );
      return false;
    }
    if (!document.getElementById("settings-panel").hidden) closeSettings();
    renderPayment();
    showPage(3);
    return true;
  } finally {
    paymentTransitionInProgress = false;
    billButton.disabled = false;
    refreshSettingsContinueButton();
  }
}
function totalQuantity() {
  return currentBill
    ? currentBill.items.reduce((sum, item) => sum + item.qty, 0)
    : [...cart.values()].reduce((sum, qty) => sum + qty, 0);
}
function showSettingsMessage(message, kind = "") {
  const feedback = document.getElementById("settings-feedback");
  feedback.textContent = message;
  feedback.className = `settings-feedback ${kind}`.trim();
}
function saveMenu(nextMenu, successMessage = "Menu settings saved.") {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextMenu));
  } catch (error) {
    showSettingsMessage(`Could not save menu settings: ${error.message}`, "error");
    return false;
  }
  menu = nextMenu;
  if (!findCategory(activeCategory)) activeCategory = menu[0]?.id || "";
  for (const itemId of [...cart.keys()]) {
    if (!findItem(itemId)) cart.delete(itemId);
  }
  renderCategories();
  renderMenu();
  renderSettingsViews();
  showSettingsMessage(successMessage, "success");
  return true;
}
function validateMenu(data) {
  if (!Array.isArray(data) || data.length === 0) return "Menu must contain at least one category.";
  const categoryIds = new Set();
  const allItemIds = new Set();
  for (const category of data) {
    if (!category || typeof category !== "object" || typeof category.id !== "string" ||
        typeof category.name !== "string" || !category.name.trim() || !Array.isArray(category.items)) {
      return "Each category needs a name and a list of food items.";
    }
    const categoryId = category.id.trim();
    if (!categoryId || categoryIds.has(categoryId)) return "Category IDs must be unique and non-empty.";
    categoryIds.add(categoryId);
    const itemNames = new Set();
    for (const item of category.items) {
      if (!item || typeof item !== "object" || typeof item.id !== "string" ||
          typeof item.name !== "string" || !item.name.trim() ||
          typeof item.price !== "number" || !Number.isFinite(item.price) || item.price < 0) {
        return "Each food item needs a name and a valid non-negative price.";
      }
      const itemId = item.id.trim();
      const normalizedName = item.name.trim().toLocaleLowerCase();
      if (!itemId || allItemIds.has(itemId)) return "Food item IDs must be unique and non-empty.";
      if (itemNames.has(normalizedName)) return `Duplicate item "${item.name.trim()}" found in ${category.name.trim()}.`;
      itemNames.add(normalizedName);
      allItemIds.add(itemId);
    }
  }
  const categoryNames = data.map(category => category.name.trim().toLocaleLowerCase());
  if (new Set(categoryNames).size !== categoryNames.length) return "Category names must be unique.";
  return "";
}
function loadMenu() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return;
    const imported = JSON.parse(stored);
    const validationError = validateMenu(imported);
    if (validationError) throw new Error(validationError);
    menu = imported.map(category => ({
      id: category.id.trim(),
      name: category.name.trim(),
      items: category.items.map(item => ({ id: item.id.trim(), name: item.name.trim(), price: item.price }))
    }));
  } catch (error) {
    menu = cloneMenu(DEFAULT_MENU);
    showSettingsMessage(`Saved menu could not be loaded; defaults are shown. ${error.message}`, "error");
  }
}
function renderCategories() {
  const tabs = document.getElementById("category-tabs");
  tabs.innerHTML = menu.map(category =>
    `<button type="button" class="category-tab ${category.id === activeCategory ? "selected" : ""}"
      role="tab" aria-selected="${category.id === activeCategory}" data-category="${escapeHtml(category.id)}">${escapeHtml(category.name)} Menu</button>`
  ).join("");
}
function renderMenu() {
  const category = findCategory(activeCategory);
  const items = category?.items || [];
  document.getElementById("menu-grid").innerHTML = items.map(item => {
    const qty = cart.get(item.id) || 0;
    return `<article class="menu-item" data-item-card="${escapeHtml(item.id)}">
      <div class="item-name">${escapeHtml(item.name)}</div>
      <div class="item-price">${rupees(item.price)}</div>
      <div class="item-actions">
        ${qty === 0
          ? `<button class="add-btn" type="button" data-add="${escapeHtml(item.id)}">+ Add</button>`
          : `<button class="qty-btn" type="button" aria-label="Decrease ${escapeHtml(item.name)}" data-minus="${escapeHtml(item.id)}">−</button>
             <span class="qty-value">${qty}</span>
             <button class="qty-btn" type="button" aria-label="Increase ${escapeHtml(item.name)}" data-plus="${escapeHtml(item.id)}">+</button>`}
      </div>
    </article>`;
  }).join("") || `<p class="empty-state">There are no food items in this category yet.</p>`;
  document.getElementById("selected-count").textContent =
    `${totalQuantity()} ${totalQuantity() === 1 ? "item" : "items"}`;
  document.getElementById("page1-total").textContent = rupees(currentTotal());
  document.getElementById("to-bill").disabled = totalQuantity() === 0;
  renderFoodSearch();
}
function createBillSnapshot() {
  const items = allItems().filter(item => cart.has(item.id)).map(item => ({
    id: item.id,
    name: item.name,
    category: item.category,
    price: item.price,
    qty: cart.get(item.id)
  }));
  currentBill = { reference: billRef, items };
}
function renderBill() {
  if (!currentBill) return;
  document.getElementById("bill-number").textContent = currentBill.reference;
  document.getElementById("bill-items").innerHTML = currentBill.items.map(item =>
    `<div class="bill-row">
      <span>${escapeHtml(item.name)}</span>
      <span class="qty">${item.qty} × ${rupees(item.price)}</span>
      <span class="line-total">${rupees(item.qty * item.price)}</span>
    </div>`
  ).join("");
  document.getElementById("bill-total").textContent = rupees(currentTotal());
}
function renderPayment() {
  document.getElementById("payment-amount").textContent = rupees(currentTotal());
  document.getElementById("payment-reference").textContent = currentBill?.reference || billRef;
  document.getElementById("payment-status").textContent = "Waiting for payment provider integration.";
  document.getElementById("payment-status").classList.remove("success");
  document.getElementById("demo-paid").disabled = false;
  document.getElementById("payment-upi-id").textContent = paymentSettings.upiId || "Not configured";
  document.getElementById("copy-upi-id").disabled = !paymentSettings.upiId;
  const qrArea = document.getElementById("qr-area");
  qrArea.replaceChildren();
  if (savedQrObjectUrl) {
    const image = document.createElement("img");
    image.src = savedQrObjectUrl;
    image.alt = "Configured payment QR code";
    image.className = "payment-qr-image";
    qrArea.append(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "qr-placeholder";
    placeholder.innerHTML = '<span class="qr-icon" aria-hidden="true">▦</span><strong>Please configure payment details in Settings.</strong>';
    qrArea.append(placeholder);
  }
  if (paymentSettings.qrBlob && !paymentSettings.upiId) {
    const note = document.createElement("p");
    note.className = "payment-configuration-note";
    note.textContent = "Please configure payment details in Settings.";
    qrArea.append(note);
  }
}
function showPage(number) {
  document.querySelectorAll(".page").forEach(page => {
    const active = page.id === `page-${number}`;
    page.classList.toggle("active", active);
    page.hidden = !active;
  });
  document.querySelectorAll("[data-step-indicator]").forEach(step => {
    const n = Number(step.dataset.stepIndicator);
    step.classList.toggle("active", n === number);
    step.classList.toggle("done", n < number);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function showSettings() {
  const activePage = [...document.querySelectorAll(".page")].find(page => page.classList.contains("active"));
  returnPage = activePage ? Number(activePage.id.split("-")[1]) : returnPage;
  document.querySelectorAll(".page").forEach(page => { page.hidden = true; page.classList.remove("active"); });
  document.getElementById("billing-steps").hidden = true;
  document.getElementById("settings-panel").hidden = false;
  document.getElementById("app-title").textContent = "Settings";
  document.getElementById("app-subtitle").textContent = "Manage your menu and prices";
  showSettingsView("home");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function closeSettings() {
  document.getElementById("settings-panel").hidden = true;
  document.getElementById("billing-steps").hidden = false;
  document.getElementById("app-title").textContent = "Billing";
  document.getElementById("app-subtitle").textContent = "Food • Bill • Payment";
  showPage(returnPage);
  if (returnPage === 2) renderBill();
  if (returnPage === 3) renderPayment();
}
function showSettingsView(name) {
  activeSettingsView = name;
  document.getElementById("settings-home").hidden = name !== "home";
  document.getElementById("menu-management").hidden = name !== "menu";
  document.getElementById("price-management").hidden = name !== "prices";
  document.getElementById("payment-management").hidden = name !== "payment";
  showSettingsMessage("");
  if (name === "payment") {
    document.getElementById("upi-id-input").value = paymentSettings.upiId;
    paymentFormDirty = false;
    clearDraftQr();
    document.getElementById("qr-upload-status").textContent = "";
  }
  if (name !== "home") renderSettingsViews();
}
function renderMenuManagement() {
  const container = document.getElementById("menu-settings-content");
  const categoryCards = menu.map(category => `
    <section class="category-management-card">
      <div class="management-card-heading">
        ${menuEdit?.type === "category" && menuEdit.id === category.id
          ? `<form class="inline-edit-form" data-edit-category-form="${escapeHtml(category.id)}">
              <label>Category name<input name="name" required maxlength="60" value="${escapeHtml(category.name)}"></label>
              <button class="small-button save-price" type="submit">Save</button>
              <button class="small-button" type="button" data-cancel-menu-edit>Cancel</button>
            </form>`
          : `<div>
          <h4>${escapeHtml(category.name)} Menu</h4>
          <p class="muted">${category.items.length} ${category.items.length === 1 ? "item" : "items"}</p>
        </div>
        <div class="management-actions">
          <button type="button" class="small-button" data-rename-category="${escapeHtml(category.id)}">Rename</button>
          <button type="button" class="small-button danger-text" data-delete-category="${escapeHtml(category.id)}">Delete category</button>
        </div>`}
      </div>
      <div class="category-item-list">${category.items.map(item => menuEdit?.type === "item" && menuEdit.id === item.id
        ? `<form class="managed-item inline-edit-form" data-edit-item-form="${escapeHtml(item.id)}">
            <label>Food name<input name="name" required maxlength="80" value="${escapeHtml(item.name)}"></label>
            <div class="management-actions"><button class="small-button save-price" type="submit">Save</button><button class="small-button" type="button" data-cancel-menu-edit>Cancel</button></div>
          </form>`
        : `<div class="managed-item">
          <span>${escapeHtml(item.name)} <small>${rupees(item.price)}</small></span>
          <div class="management-actions">
            <button type="button" class="small-button" data-rename-item="${escapeHtml(item.id)}">Edit</button>
            <button type="button" class="small-button danger-text" data-delete-item="${escapeHtml(item.id)}">Delete</button>
          </div>
        </div>`).join("") || `<p class="empty-state compact">No items in this category.</p>`}</div>
    </section>`).join("");
  container.innerHTML = `
    <div class="search-wrap">
      <label for="menu-search">Search food items</label>
      <input id="menu-search" type="search" placeholder="Search by food name">
    </div>
    <div id="menu-category-list" class="management-list">${categoryCards}</div>
    <button class="primary-button add-item-trigger" type="button" data-open-add-item>Add Item</button>
    <form id="add-item-form" class="form-card" novalidate ${addItemFormOpen ? "" : "hidden"}>
      <h4>Add a food item</h4>
      <div class="form-grid">
        <label>Food name<input name="name" required maxlength="80" autocomplete="off"></label>
        <label>Category<select name="categoryId" required>${menu.map(category =>
          `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)} Menu</option>`).join("")}</select></label>
        <label>Price (₹)<input name="price" type="number" min="0" step="0.01" required inputmode="decimal"></label>
      </div>
      <div class="form-actions">
        <button class="primary-button" type="submit">Save Item</button>
        <button class="secondary-button" type="button" data-cancel-add-item>Cancel</button>
      </div>
    </form>
    <form id="add-category-form" class="form-card inline-form">
      <h4>Add a food category</h4>
      <label>Category name<input name="name" required maxlength="60" autocomplete="off"></label>
      <button class="secondary-button" type="submit">Add Category</button>
    </form>`;
  document.getElementById("menu-search").addEventListener("input", event => {
    const query = event.target.value.trim().toLocaleLowerCase();
    document.querySelectorAll(".category-management-card").forEach(card => {
      const matching = [...card.querySelectorAll(".managed-item")].filter(row =>
        row.querySelector("span").textContent.toLocaleLowerCase().includes(query));
      card.hidden = Boolean(query) && matching.length === 0;
      card.querySelectorAll(".managed-item").forEach(row => {
        row.hidden = Boolean(query) && !row.querySelector("span").textContent.toLocaleLowerCase().includes(query);
      });
    });
  });
  document.getElementById("add-category-form").addEventListener("submit", event => {
    event.preventDefault();
    const name = event.currentTarget.elements.name.value.trim();
    if (!name) {
      showSettingsMessage("Enter a category name.", "error");
      return;
    }
    if (menu.some(category => category.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      showSettingsMessage("A category with that name already exists.", "error");
      return;
    }
    const next = cloneMenu(menu);
    next.push({ id: createId("category"), name, items: [] });
    if (saveMenu(next)) renderSettingsViews();
  });
}
function renderPriceManagement() {
  const query = document.getElementById("price-search").value.trim().toLocaleLowerCase();
  const entries = allItems().filter(item =>
    `${item.name} ${item.category}`.toLocaleLowerCase().includes(query));
  const container = document.getElementById("price-settings-content");
  container.innerHTML = entries.length ? `<div class="price-list">${entries.map(item => {
    const editing = item.id === priceDraftId;
    return `<div class="price-row">
      <div class="price-item-name"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category)}</small></div>
      ${editing
        ? `<label class="price-edit-field">New price (₹)<input type="number" min="0" step="0.01" inputmode="decimal" value="${item.price}" data-price-input="${escapeHtml(item.id)}"></label>
           <div class="management-actions"><button class="small-button save-price" type="button" data-save-price="${escapeHtml(item.id)}">Save</button><button class="small-button" type="button" data-cancel-price>Cancel</button></div>`
        : `<strong class="price-value">${rupees(item.price)}</strong>
           <div class="management-actions"><button class="small-button" type="button" data-edit-price="${escapeHtml(item.id)}">Edit</button><button class="small-button danger-text" type="button" data-delete-item="${escapeHtml(item.id)}">Delete</button></div>`}
    </div>`;
  }).join("")}</div>` : `<p class="empty-state">No matching food items.</p>`;
}
function renderSettingsViews() {
  if (activeSettingsView === "menu") renderMenuManagement();
  if (activeSettingsView === "prices") renderPriceManagement();
  if (activeSettingsView === "payment") renderPaymentSettings();
}
function renderPaymentSettingsPreview() {
  const preview = document.getElementById("settings-payment-preview");
  const upi = document.getElementById("upi-id-input").value.trim() || paymentSettings.upiId;
  document.getElementById("settings-payment-upi").textContent = upi || "Not configured";
  const imageUrl = draftQrObjectUrl || savedQrObjectUrl;
  preview.replaceChildren();
  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = draftQrBlob ? "Selected payment QR preview (not yet saved)" : "Saved payment QR code";
    image.className = "payment-qr-image settings-qr-image";
    preview.append(image);
    if (draftQrBlob) {
      const pending = document.createElement("p");
      pending.className = "payment-settings-note";
      pending.textContent = "Replacement QR selected. Save Payment Settings to apply it.";
      preview.append(pending);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Please configure payment details in Settings.";
    preview.append(empty);
  }
  document.getElementById("upload-qr-button").hidden = Boolean(paymentSettings.qrBlob || draftQrBlob);
  document.getElementById("replace-qr-button").hidden = !paymentSettings.qrBlob && !draftQrBlob;
  document.getElementById("remove-qr-button").hidden = !paymentSettings.qrBlob && !draftQrBlob;
}
function renderPaymentSettings() {
  if (!paymentSettingsLoaded) return;
  renderPaymentSettingsPreview();
  refreshSettingsContinueButton();
}
function deleteMenuItem(itemId) {
  const found = findItem(itemId);
  if (!found || !window.confirm(`Delete "${found.item.name}"? This will remove it from new bills.`)) return;
  const next = cloneMenu(menu);
  const category = findCategory(found.category.id, next);
  category.items = category.items.filter(item => item.id !== itemId);
  if (saveMenu(next)) renderSettingsViews();
}
function updateCartQuantity(itemId, delta) {
  if (!findItem(itemId)) return false;
  const quantity = Math.max(0, (cart.get(itemId) || 0) + delta);
  if (quantity === 0) cart.delete(itemId);
  else cart.set(itemId, quantity);
  currentBill = null;
  renderMenu();
  return true;
}
function normalizeSearchText(value) {
  return String(value).toLocaleLowerCase().trim().replace(/\s+/g, " ");
}
function renderFoodSearch() {
  const input = document.getElementById("food-search-input");
  if (!input) return;
  const query = normalizeSearchText(input.value);
  const results = document.getElementById("food-search-results");
  const tabs = document.getElementById("category-tabs");
  const grid = document.getElementById("menu-grid");
  document.getElementById("food-search-clear").hidden = !query;
  tabs.hidden = Boolean(query);
  grid.hidden = Boolean(query);
  results.hidden = !query;
  if (!query) {
    results.replaceChildren();
    return;
  }
  const matches = allItems().filter(item =>
    normalizeSearchText(item.name).includes(query) || normalizeSearchText(item.category).includes(query));
  if (!matches.length) {
    results.innerHTML = '<p class="empty-state search-empty">No food items found</p>';
    return;
  }
  results.innerHTML = matches.map(item => {
    const quantity = cart.get(item.id) || 0;
    return '<article class="menu-item search-result-card" data-search-result="' + escapeHtml(item.id) + '">' +
      '<div class="search-result-main">' +
        '<div class="item-name">' + escapeHtml(item.name) + '</div>' +
        '<div class="search-result-category">' + escapeHtml(item.category) + '</div>' +
        '<div class="item-price">' + rupees(item.price) + '</div>' +
      '</div>' +
      '<div class="search-result-action">' +
        (quantity ? '<span class="search-result-quantity">In bill: ' + quantity + '</span>' : '') +
        '<button class="add-btn" type="button" data-search-add="' + escapeHtml(item.id) + '">+ Add</button>' +
      '</div>' +
    '</article>';
  }).join("");
}
function addMenuItemToBill(itemId) {
  const found = findItem(itemId);
  if (!found) {
    console.error("Could not add searched food item: it no longer exists in the current menu.", { itemId });
    return;
  }
  if (!updateCartQuantity(itemId, 1)) return;
  console.info("Added searched food item to bill.", {
    item: found.item.name,
    category: found.category.name,
    unitPrice: found.item.price,
    quantity: cart.get(itemId),
    total: currentTotal()
  });
}
document.getElementById("category-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  activeCategory = button.dataset.category;
  renderCategories();
  renderMenu();
});
document.getElementById("menu-grid").addEventListener("click", event => {
  const button = event.target.closest("[data-add], [data-plus], [data-minus]");
  if (!button) return;
  const itemId = button.dataset.add || button.dataset.plus || button.dataset.minus;
  if (!findItem(itemId)) return;
  if (button.dataset.minus !== undefined) {
    updateCartQuantity(itemId, -1);
  } else {
    updateCartQuantity(itemId, 1);
  }
});
document.getElementById("food-search-input").addEventListener("input", renderFoodSearch);
document.getElementById("food-search-clear").addEventListener("click", () => {
  const input = document.getElementById("food-search-input");
  input.value = "";
  renderFoodSearch();
  input.focus();
});
document.getElementById("food-search-results").addEventListener("click", event => {
  const button = event.target.closest("[data-search-add]");
  if (!button) return;
  addMenuItemToBill(button.dataset.searchAdd);
});
document.getElementById("clear-cart").addEventListener("click", () => {
  cart.clear();
  currentBill = null;
  renderMenu();
});
document.getElementById("to-bill").addEventListener("click", () => {
  if (!totalQuantity()) return;
  createBillSnapshot();
  renderBill();
  showPage(2);
});
document.getElementById("back-to-food").addEventListener("click", () => {
  currentBill = null;
  showPage(1);
  renderMenu();
});
document.getElementById("to-payment").addEventListener("click", () => {
  if (!document.getElementById("page-2").classList.contains("active")) return;
  void continueToPayment().catch(error => {
    console.error("Could not continue to payment.", error);
    if (document.getElementById("settings-panel").hidden) {
      showSettings();
      showSettingsView("payment");
    }
    showSettingsMessage(`Could not open payment: ${error.message}`, "error");
  });
});
document.getElementById("back-to-bill").addEventListener("click", () => {
  renderBill();
  showPage(2);
});
document.getElementById("new-bill").addEventListener("click", () => {
  cart.clear();
  currentBill = null;
  activeCategory = menu[0]?.id || "";
  billRef = createBillReference();
  renderCategories();
  renderMenu();
  showPage(1);
});
document.getElementById("demo-paid").addEventListener("click", () => {
  const status = document.getElementById("payment-status");
  status.textContent = "DEMO ONLY — no payment was received or verified.";
  status.classList.add("success");
  document.getElementById("demo-paid").disabled = true;
});
document.getElementById("open-settings").addEventListener("click", showSettings);
document.getElementById("back-from-settings").addEventListener("click", closeSettings);
document.querySelectorAll("[data-settings-view]").forEach(button => {
  button.addEventListener("click", () => showSettingsView(button.dataset.settingsView));
});
document.querySelectorAll("[data-settings-home]").forEach(button => {
  button.addEventListener("click", () => showSettingsView("home"));
});
document.getElementById("upi-id-input").addEventListener("input", renderPaymentSettingsPreview);
document.getElementById("upi-id-input").addEventListener("input", () => { paymentFormDirty = true; });
document.getElementById("upi-settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  const upiId = document.getElementById("upi-id-input").value.trim();
  if (!upiId) return showSettingsMessage("Enter a UPI ID before saving.", "error");
  if (!isValidUpiId(upiId)) return showSettingsMessage("Enter a valid UPI ID, for example yourname@upi.", "error");
  try {
    await waitForPaymentSettings();
    await writePaymentSettings({ upiId, updateQr: false });
    paymentSettings = { ...paymentSettings, upiId };
    paymentFormDirty = false;
    renderPayment();
    renderPaymentSettingsPreview();
    refreshSettingsContinueButton();
    showSettingsMessage("UPI ID saved successfully.", "success");
  } catch (error) {
    console.error("Could not save UPI ID.", error);
    showSettingsMessage(`Could not save UPI ID: ${error.message}`, "error");
  }
});
const paymentQrInput = document.getElementById("payment-qr-file");
document.getElementById("upload-qr-button").addEventListener("click", () => paymentQrInput.click());
document.getElementById("replace-qr-button").addEventListener("click", () => paymentQrInput.click());
paymentQrInput.addEventListener("change", async event => {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  try {
    await validateQrImage(file);
    clearDraftQr();
    draftQrBlob = file.slice(0, file.size, file.type);
    draftQrObjectUrl = URL.createObjectURL(draftQrBlob);
    paymentFormDirty = true;
    document.getElementById("qr-upload-status").textContent = "QR image selected. Save Payment Settings to apply it.";
    renderPaymentSettingsPreview();
  } catch (error) {
    console.error("Rejected uploaded payment QR image.", error);
    document.getElementById("qr-upload-status").textContent = error.message;
    showSettingsMessage(error.message, "error");
  } finally {
    input.value = "";
  }
});
document.getElementById("remove-qr-button").addEventListener("click", async () => {
  if (!window.confirm("Remove the configured payment QR code?")) return;
  try {
    await waitForPaymentSettings();
    if (paymentSettings.qrBlob) {
      const database = await openPaymentDatabase();
      const transaction = database.transaction(PAYMENT_STORE_NAME, "readwrite");
      const done = transactionCompletion(transaction);
      transaction.objectStore(PAYMENT_STORE_NAME).delete("qrCode");
      await done;
    }
    clearDraftQr();
    if (savedQrObjectUrl) URL.revokeObjectURL(savedQrObjectUrl);
    savedQrObjectUrl = null;
    paymentSettings = { ...paymentSettings, qrBlob: null };
    paymentFormDirty = false;
    document.getElementById("qr-upload-status").textContent = "QR code removed.";
    renderPayment();
    renderPaymentSettingsPreview();
    showSettingsMessage("QR code removed successfully.", "success");
  } catch (error) {
    console.error("Could not remove saved payment QR image.", error);
    showSettingsMessage(`Could not remove QR code: ${error.message}`, "error");
  }
});
document.getElementById("save-payment-settings").addEventListener("click", async () => {
  try {
    await persistPaymentSettings({ requireQr: true });
  } catch (error) {
    console.error("Could not save payment settings.", error);
    showSettingsMessage(`Could not save payment settings: ${error.message}`, "error");
  }
});
document.getElementById("settings-continue-payment").addEventListener("click", () => {
  void continueToPayment().catch(error => {
    console.error("Could not continue from Payment Settings.", error);
    showSettingsMessage(`Could not continue to payment: ${error.message}`, "error");
  });
});
document.getElementById("cancel-payment-settings").addEventListener("click", () => {
  clearDraftQr();
  paymentFormDirty = false;
  document.getElementById("upi-id-input").value = paymentSettings.upiId;
  document.getElementById("qr-upload-status").textContent = "Unsaved changes discarded.";
  renderPaymentSettingsPreview();
  showSettingsMessage("Unsaved payment changes discarded.", "success");
});
document.getElementById("copy-upi-id").addEventListener("click", async () => {
  if (!paymentSettings.upiId) return;
  const status = document.getElementById("payment-status");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(paymentSettings.upiId);
    } else {
      const input = document.createElement("textarea");
      input.value = paymentSettings.upiId;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) throw new Error("Clipboard access is unavailable in this browser.");
    }
    status.textContent = "UPI ID copied.";
    status.classList.remove("error");
  } catch (error) {
    console.error("Could not copy UPI ID.", error);
    status.textContent = "Could not copy the UPI ID. Select and copy it manually.";
    status.classList.add("error");
  }
});
document.getElementById("price-search").addEventListener("input", () => {
  priceDraftId = null;
  renderPriceManagement();
});
document.getElementById("menu-settings-content").addEventListener("click", event => {
  if (event.target.closest("[data-open-add-item]")) {
    addItemFormOpen = true;
    renderMenuManagement();
    document.querySelector('#add-item-form [name="name"]')?.focus();
    return;
  }
  if (event.target.closest("[data-cancel-add-item]")) {
    addItemFormOpen = false;
    renderMenuManagement();
    return;
  }
  const renameCategory = event.target.closest("[data-rename-category]");
  if (renameCategory) {
    menuEdit = { type: "category", id: renameCategory.dataset.renameCategory };
    renderMenuManagement();
    return;
  }
  const deleteCategory = event.target.closest("[data-delete-category]");
  if (deleteCategory) {
    const category = findCategory(deleteCategory.dataset.deleteCategory);
    if (!category || !window.confirm(`Delete category "${category.name}" and all ${category.items.length} item(s) in it?`)) return;
    const next = menu.filter(entry => entry.id !== category.id);
    if (!next.length) return showSettingsMessage("At least one food category must remain.", "error");
    if (saveMenu(next)) renderSettingsViews();
    return;
  }
  const renameItem = event.target.closest("[data-rename-item]");
  if (renameItem) {
    menuEdit = { type: "item", id: renameItem.dataset.renameItem };
    renderMenuManagement();
    return;
  }
  if (event.target.closest("[data-cancel-menu-edit]")) {
    menuEdit = null;
    renderMenuManagement();
    return;
  }
  const deleteItem = event.target.closest("[data-delete-item]");
  if (deleteItem) deleteMenuItem(deleteItem.dataset.deleteItem);
});
document.getElementById("menu-settings-content").addEventListener("submit", event => {
  const form = event.target;
  if (form.id === "add-item-form") {
    event.preventDefault();
    const name = form.querySelector('[name="name"]').value.trim();
    const categoryId = form.querySelector('[name="categoryId"]').value;
    const rawPrice = form.querySelector('[name="price"]').value.trim();
    const price = Number(rawPrice);
    const category = findCategory(categoryId);
    if (!name) return showSettingsMessage("Food name cannot be empty.", "error");
    if (!category) return showSettingsMessage("Select a valid food category.", "error");
    if (!rawPrice || !Number.isFinite(price) || price < 0) {
      return showSettingsMessage("Price must be a valid, non-negative number.", "error");
    }
    if (category.items.some(item => item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return showSettingsMessage("That food item already exists in this category.", "error");
    }
    const next = cloneMenu(menu);
    findCategory(categoryId, next).items.push({ id: createId("item"), name, price });
    addItemFormOpen = false;
    saveMenu(next, "Food item added successfully!");
    return;
  }
  if (form.matches("[data-edit-category-form]")) {
    event.preventDefault();
    const categoryId = form.dataset.editCategoryForm;
    const name = form.elements.name.value.trim();
    if (!name) return showSettingsMessage("Category name cannot be empty.", "error");
    if (menu.some(entry => entry.id !== categoryId && entry.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return showSettingsMessage("A category with that name already exists.", "error");
    }
    const next = cloneMenu(menu);
    findCategory(categoryId, next).name = name;
    menuEdit = null;
    saveMenu(next);
    return;
  }
  if (form.matches("[data-edit-item-form]")) {
    event.preventDefault();
    const itemId = form.dataset.editItemForm;
    const found = findItem(itemId);
    const name = form.elements.name.value.trim();
    if (!found || !name) return showSettingsMessage("Food item name cannot be empty.", "error");
    if (found.category.items.some(item => item.id !== itemId && item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return showSettingsMessage("That food item already exists in this category.", "error");
    }
    const next = cloneMenu(menu);
    findItem(itemId, next).item.name = name;
    menuEdit = null;
    saveMenu(next);
  }
});
document.getElementById("price-settings-content").addEventListener("click", event => {
  const edit = event.target.closest("[data-edit-price]");
  if (edit) {
    priceDraftId = edit.dataset.editPrice;
    renderPriceManagement();
    document.querySelector(`[data-price-input="${CSS.escape(priceDraftId)}"]`)?.focus();
    return;
  }
  const cancel = event.target.closest("[data-cancel-price]");
  if (cancel) {
    priceDraftId = null;
    renderPriceManagement();
    return;
  }
  const save = event.target.closest("[data-save-price]");
  if (save) {
    const priceInput = document.querySelector(`[data-price-input="${CSS.escape(save.dataset.savePrice)}"]`);
    const price = Number(priceInput?.value);
    if (!priceInput || priceInput.value.trim() === "" || !Number.isFinite(price) || price < 0) {
      showSettingsMessage("Enter a valid, non-negative price.", "error");
      priceInput?.focus();
      return;
    }
    const next = cloneMenu(menu);
    findItem(save.dataset.savePrice, next).item.price = price;
    if (saveMenu(next)) {
      priceDraftId = null;
      renderPriceManagement();
    }
  }
  const deleteItem = event.target.closest("[data-delete-item]");
  if (deleteItem) deleteMenuItem(deleteItem.dataset.deleteItem);
});
document.getElementById("export-menu").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(menu, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "gpk-tiffin-menu.json";
  link.click();
  URL.revokeObjectURL(url);
  showSettingsMessage("Menu exported as gpk-tiffin-menu.json.", "success");
});
document.getElementById("import-menu").addEventListener("click", () => {
  document.getElementById("import-menu-file").click();
});
document.getElementById("import-menu-file").addEventListener("change", async event => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    const validationError = validateMenu(imported);
    if (validationError) {
      showSettingsMessage(`Import rejected: ${validationError}`, "error");
      return;
    }
    const normalized = imported.map(category => ({
      id: category.id.trim(),
      name: category.name.trim(),
      items: category.items.map(item => ({ id: item.id.trim(), name: item.name.trim(), price: item.price }))
    }));
    if (!window.confirm("Import this menu and replace the current menu settings?")) return;
    if (saveMenu(normalized)) priceDraftId = null;
  } catch (error) {
    showSettingsMessage(`Could not read menu file: ${error.message}`, "error");
  } finally {
    event.currentTarget.value = "";
  }
});
document.getElementById("reset-menu").addEventListener("click", () => {
  if (!window.confirm("Reset all categories, food items, and prices to the default menu?")) return;
  if (saveMenu(cloneMenu(DEFAULT_MENU))) {
    priceDraftId = null;
    showSettingsView("home");
    showSettingsMessage("Menu reset to defaults.", "success");
  }
});

loadMenu();
activeCategory = menu[0]?.id || "";
renderCategories();
renderMenu();
paymentSettingsLoadPromise = loadPaymentSettings();
window.addEventListener("pagehide", () => {
  if (savedQrObjectUrl) URL.revokeObjectURL(savedQrObjectUrl);
  if (draftQrObjectUrl) URL.revokeObjectURL(draftQrObjectUrl);
});
