const API_BASE = "/api";
const DEVICE_ID = "esp32-01";
const titles = {
  dashboard: ["OVERVIEW", "Dashboard"],
  students: ["MANAGEMENT", "Students"],
  attendance: ["MONITORING", "Attendance"],
  reports: ["ANALYTICS", "Reports"],
};

let adminKey = localStorage.getItem("antende_admin_key") || "";
let serverDate = "";
let classes = [];
let students = [];
let attendanceRows = [];
let reportRows = [];
let scanNotificationCursor = null;
let scanNotificationTimer;
let scanNotificationPolling = false;
let scanNotificationFailed = false;

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
function today() {
  if (serverDate) return serverDate;
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${adminKey}`);
  if (options.body) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(`${API_BASE}${url}`, { ...options, headers });
  } catch {
    throw new Error("Cannot reach the antende server. Check your connection and try again.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem("antende_admin_key");
      adminKey = "";
      showLogin("Your administrator key was rejected. Please sign in again.");
    }
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload;
}

function showLogin(message = "") {
  clearInterval(scanNotificationTimer);
  scanNotificationTimer = null;
  $("#appShell").classList.add("hidden");
  $("#loginScreen").classList.remove("hidden");
  $("#loginError").textContent = message;
  $("#apiKey").value = "";
}

function showApp() {
  $("#loginScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  $("#todayLabel").textContent = serverDate;
}

function notify(message, type = "success", title, target = "#notifications") {
  const resolvedType = type === true ? "error" : type === false ? "success" : type;
  const titles = {
    success: "Success",
    error: "Something went wrong",
    warning: "Please note",
    info: "Information",
  };
  const icons = { success: "✓", error: "!", warning: "!", info: "i" };
  const toast = document.createElement("div");
  toast.className = `toast ${resolvedType}`;
  toast.setAttribute("role", resolvedType === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = icons[resolvedType] || icons.info;

  const content = document.createElement("span");
  content.className = "toast-content";
  const heading = document.createElement("strong");
  heading.textContent = title || titles[resolvedType] || titles.info;
  const detail = document.createElement("span");
  detail.textContent = message;
  content.append(heading, detail);

  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "×";
  close.addEventListener("click", () => dismissToast(toast));

  toast.append(icon, content, close);
  $(target).append(toast);
  setTimeout(() => dismissToast(toast), 6000);
}

function dismissToast(toast) {
  if (!toast.isConnected) return;
  toast.classList.add("removing");
  setTimeout(() => toast.remove(), 200);
}

function showScanNotification(event) {
  const name = event.student?.full_name;
  const target = $("#view-attendance").classList.contains("hidden")
    ? "#notifications"
    : "#attendanceNotifications";
  if (event.status === "accepted") {
    notify(`${name || "Student"} checked in successfully.`, "success", "Attendance recorded", target);
  } else if (event.status === "duplicate") {
    notify(`${name || "This student"}'s attendance was already recorded today.`, "warning", "Attendance already recorded", target);
  } else if (event.status === "unknown") {
    notify(`Card ${event.uid} is not linked to an active student.`, "error", "Unknown card", target);
  }
}

async function pollScanNotifications() {
  if (scanNotificationPolling || !adminKey) return;
  scanNotificationPolling = true;
  try {
    const url = scanNotificationCursor == null
      ? "/scan-notifications"
      : `/scan-notifications?after=${scanNotificationCursor}`;
    const result = await api(url);
    scanNotificationCursor = result.latestId;
    result.notifications.forEach(showScanNotification);
    scanNotificationFailed = false;
  } catch (error) {
    if (!scanNotificationFailed) {
      notify(error.message, "error", "Live scan updates unavailable");
      scanNotificationFailed = true;
    }
  } finally {
    scanNotificationPolling = false;
  }
}

function startScanNotifications() {
  clearInterval(scanNotificationTimer);
  scanNotificationCursor = null;
  scanNotificationFailed = false;
  pollScanNotifications();
  scanNotificationTimer = setInterval(pollScanNotifications, 1500);
}

function renderEmpty(target, message, columns) {
  $(target).innerHTML = `<tr><td class="empty-state" colspan="${columns}">${escapeHtml(message)}</td></tr>`;
}

function renderStudentCell(student) {
  return `<span class="student-cell"><span class="student-avatar">${escapeHtml(initials(student.full_name))}</span><strong>${escapeHtml(student.full_name)}</strong></span>`;
}

function renderStatus(status) {
  return `<span class="badge${status ? "" : " inactive"}"><span>●</span>${status ? "Active" : "Inactive"}</span>`;
}

function renderStudentStatus(student) {
  if (student.active_status) return renderStatus(true);
  const label = student.exit_reason === "finished"
    ? "Finished"
    : student.exit_reason === "dropped" ? "Dropped" : "Inactive";
  return `<span class="badge inactive"><span>●</span>${label}</span>`;
}

function setClassOptions(selector, includeAll = false) {
  const select = $(selector);
  const previous = select.value;
  const firstOption = includeAll
    ? '<option value="">All classes</option>'
    : '<option value="">Unassigned</option>';
  select.innerHTML = `${firstOption}${classes.map((item) =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.class_name)}</option>`).join("")}`;
  if (classes.some((item) => item.id === previous)) select.value = previous;
}

async function loadClasses() {
  classes = await api("/classes");
  setClassOptions("#studentClass");
  setClassOptions("#studentClassFilter", true);
  setClassOptions("#attendanceClassFilter", true);
}

async function loadStudents() {
  const search = $("#studentSearch").value.trim();
  const classId = $("#studentClassFilter").value;
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (classId) query.set("classId", classId);
  students = await api(`/students${query.size ? `?${query}` : ""}`);
  $("#studentCount").textContent = `${students.length} student${students.length === 1 ? "" : "s"}`;
  if (!students.length) return renderEmpty("#studentsTable", "No students found. Register a student to get started.", 6);
  $("#studentsTable").innerHTML = students.map((student) => `<tr>
    <td>${renderStudentCell(student)}</td>
    <td>${escapeHtml(student.student_id)}</td>
    <td>${escapeHtml(student.classes?.class_name || "—")}</td>
    <td>${escapeHtml(student.registration_date || "—")}</td>
    <td>${renderStudentStatus(student)}</td>
    <td><span class="row-actions">
      <button class="row-action" data-action="edit" data-id="${escapeHtml(student.id)}">Edit</button>
      ${student.active_status
        ? `<button class="row-action danger" data-action="finished" data-id="${escapeHtml(student.id)}">Finished</button>
           <button class="row-action danger" data-action="dropped" data-id="${escapeHtml(student.id)}">Dropped</button>`
        : `<button class="row-action" data-action="activate" data-id="${escapeHtml(student.id)}">Activate</button>`}
    </span></td>
  </tr>`).join("");
}

async function loadDashboard() {
  const summary = await api("/reports/daily");
  $("#statStudents").textContent = summary.totalStudents;
  $("#statPresent").textContent = summary.present;
  $("#statAbsent").textContent = summary.absent;
  $("#statRate").textContent = `${summary.attendancePercentage}%`;
  $("#dashboardDate").textContent = `${summary.date} · ${summary.timeZone}`;
  if (!summary.records.length) return renderEmpty("#dashboardRecords", "No attendance has been recorded today.", 5);
  $("#dashboardRecords").innerHTML = summary.records.map((record) => `<tr>
    <td>${renderStudentCell(record.students)}</td>
    <td>${escapeHtml(record.students.student_id)}</td>
    <td>${escapeHtml(record.students.classes?.class_name || "—")}</td>
    <td>${escapeHtml(record.attendance_time)}</td>
    <td><span class="badge"><span>●</span>Present</span></td>
  </tr>`).join("");
}

async function loadAttendance() {
  const query = new URLSearchParams();
  if ($("#attendanceFrom").value) query.set("from", $("#attendanceFrom").value);
  if ($("#attendanceTo").value) query.set("to", $("#attendanceTo").value);
  if ($("#attendanceClassFilter").value) query.set("classId", $("#attendanceClassFilter").value);
  attendanceRows = await api(`/attendance${query.size ? `?${query}` : ""}`);
  $("#attendanceCount").textContent = `${attendanceRows.length} record${attendanceRows.length === 1 ? "" : "s"}`;
  if (!attendanceRows.length) return renderEmpty("#attendanceTable", "No records match these filters.", 6);
  $("#attendanceTable").innerHTML = attendanceRows.map((record) => `<tr>
    <td>${renderStudentCell(record.students)}</td>
    <td>${escapeHtml(record.students.student_id)}</td>
    <td>${escapeHtml(record.students.classes?.class_name || "—")}</td>
    <td>${escapeHtml(record.attendance_date)}</td>
    <td>${escapeHtml(record.attendance_time)}</td>
    <td><span class="badge"><span>●</span>Present</span></td>
  </tr>`).join("");
}

async function loadReport() {
  const period = $("#reportPeriod").value;
  const date = $("#reportDate").value || today();
  const report = await api(`/reports/summary?period=${encodeURIComponent(period)}&date=${encodeURIComponent(date)}`);
  reportRows = report.records;
  $("#reportRange").textContent = `${report.from} to ${report.to} · ${report.timeZone}`;
  $("#reportStudents").textContent = report.activeStudents;
  $("#reportPresent").textContent = report.attendanceCount;
  $("#reportAbsent").textContent = report.absentCount;
  $("#reportRate").textContent = `${report.attendancePercentage}%`;
}

async function loadHistory() {
  const studentId = $("#historyStudent").value;
  if (!studentId) return notify("Select a student to view their history.", true);
  const history = await api(`/reports/student/${encodeURIComponent(studentId)}`);
  if (!history.records.length) return renderEmpty("#historyTable", "This student has no attendance records.", 5);
  $("#historyTable").innerHTML = history.records.map((record) => `<tr>
    <td>${escapeHtml(record.attendance_date)}</td>
    <td>${escapeHtml(record.attendance_time)}</td>
    <td>${escapeHtml(history.student.student_id)}</td>
    <td>${escapeHtml(record.students.classes?.class_name || history.student.classes?.class_name || "—")}</td>
    <td><span class="badge"><span>●</span>Present</span></td>
  </tr>`).join("");
}

async function refreshView(view) {
  if (view === "dashboard") return loadDashboard();
  if (view === "students") {
    await loadClasses();
    await loadStudents();
    return;
  }
  if (view === "attendance") {
    await loadClasses();
    await loadAttendance();
    return;
  }
  if (view === "reports") {
    if (!students.length) students = await api("/students");
    $("#historyStudent").innerHTML = `<option value="">Select a student</option>${students.map((student) =>
      `<option value="${escapeHtml(student.id)}">${escapeHtml(student.full_name)} · ${escapeHtml(student.student_id)}</option>`).join("")}`;
    return loadReport();
  }
}

async function navigate(view) {
  $(".view:not(.hidden)")?.classList.add("hidden");
  $(`#view-${view}`).classList.remove("hidden");
  $("#mainNav .active")?.classList.remove("active");
  $(`#mainNav [data-view="${view}"]`).classList.add("active");
  $("#pageEyebrow").textContent = titles[view][0];
  $("#pageTitle").textContent = titles[view][1];
  try {
    await refreshView(view);
  } catch (error) {
    notify(error.message, true);
  }
}

function openStudentDialog(student = null) {
  $("#studentForm").reset();
  $("#studentFormError").textContent = "";
  $("#scanStatus").textContent = "";
  $("#studentNotifications").replaceChildren();
  $("#studentRecordId").value = student?.id || "";
  $("#studentDialogTitle").textContent = student ? "Edit student" : "Register student";
  $("#fullName").value = student?.full_name || "";
  $("#studentUid").value = student?.student_id || "";
  $("#studentClass").value = student?.class_id || "";
  $("#studentGender").value = student?.gender || "";
  $("#studentPhone").value = student?.phone || "";
  $("#studentEmail").value = student?.email || "";
  $("#studentDialog").showModal();
}

async function scanCard() {
  $("#scanCardButton").disabled = true;
  $("#scanStatus").textContent = "Waiting for a card tap on the ESP32 reader (request expires in 2 minutes)…";
  try {
    const request = await api("/registration/scan-requests", { method: "POST", body: "{}" });
    const deadline = Date.now() + Math.max(0, Date.parse(request.expires_at) - Date.now());
    while (Date.now() < deadline) {
      await sleep(1200);
      const state = await api(`/registration/scan-requests/${encodeURIComponent(request.id)}`);
      if (state.status === "scanned") {
        $("#studentUid").value = state.uid;
        $("#scanStatus").textContent = `Card scanned: ${state.uid}`;
        const query = new URLSearchParams({ search: state.uid });
        let matches;
        try {
          matches = await api(`/students?${query}`);
        } catch (error) {
          notify(error.message, "error", "Could not check card assignment", "#studentNotifications");
          return;
        }
        const existing = matches.find((student) =>
          student.student_id.toUpperCase() === state.uid.toUpperCase());
        if (existing?.active_status) {
          notify(`This card is already assigned to ${existing.full_name}.`, "warning", "Card already registered", "#studentNotifications");
        } else if (existing) {
          notify(`This card was previously assigned to ${existing.full_name} and is available for reuse.`, "info", "Card available", "#studentNotifications");
        } else {
          notify(`Card ${state.uid} is ready to assign to a student.`, "success", "Card scanned", "#studentNotifications");
        }
        return;
      }
      if (state.status === "expired") throw new Error("No card was scanned before the request expired.");
    }
    throw new Error("The scan request expired. Start a new scan.");
  } catch (error) {
    $("#scanStatus").textContent = error.message;
    notify(error.message, "error", "Card scan failed", "#studentNotifications");
  } finally {
    $("#scanCardButton").disabled = false;
  }
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((value) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  adminKey = $("#apiKey").value.trim();
  try {
    await api("/classes");
    const health = await api("/health");
    serverDate = health.date;
    $("#deviceIdLabel").textContent = health.deviceId;
    $("#attendanceFrom").value = serverDate;
    $("#attendanceTo").value = serverDate;
    $("#reportDate").value = serverDate;
    localStorage.setItem("antende_admin_key", adminKey);
    showApp();
    startScanNotifications();
    await navigate("dashboard");
  } catch (error) {
    $("#loginError").textContent = error.message;
  }
});

$("#logoutButton").addEventListener("click", () => {
  clearInterval(scanNotificationTimer);
  scanNotificationTimer = null;
  localStorage.removeItem("antende_admin_key");
  adminKey = "";
  showLogin();
});

$("#mainNav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) navigate(button.dataset.view);
});

document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => navigate(button.dataset.go));
});

$("#refreshDashboard").addEventListener("click", () => navigate("dashboard"));
$("#addStudentButton").addEventListener("click", async () => {
  try {
    await loadClasses();
    openStudentDialog();
  } catch (error) {
    notify(error.message, true);
  }
});
$("#closeDialog").addEventListener("click", () => $("#studentDialog").close());
$("#cancelStudent").addEventListener("click", () => $("#studentDialog").close());
$("#scanCardButton").addEventListener("click", scanCard);
$("#studentSearch").addEventListener("input", () => {
  clearTimeout(window.studentSearchTimer);
  window.studentSearchTimer = setTimeout(() => loadStudents().catch((error) => notify(error.message, true)), 250);
});
$("#studentClassFilter").addEventListener("change", () => loadStudents().catch((error) => notify(error.message, true)));

$("#studentsTable").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const student = students.find((item) => item.id === button.dataset.id);
  if (!student) return;
  if (button.dataset.action === "edit") {
    try {
      await loadClasses();
      openStudentDialog(student);
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (button.dataset.action === "activate") {
    try {
      await api(`/students/${encodeURIComponent(student.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          full_name: student.full_name,
          student_id: student.student_id,
          class_id: student.class_id,
          gender: student.gender,
          phone: student.phone,
          email: student.email,
          active_status: true,
        }),
      });
      notify("Student reactivated.");
      await loadStudents();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (button.dataset.action === "finished" || button.dataset.action === "dropped") {
    const exitReason = button.dataset.action;
    const label = exitReason === "finished" ? "finished their studies" : "dropped their studies";
    if (!confirm(`Mark ${student.full_name} as having ${label}? Attendance history will be preserved, and RFID card ${student.student_id} can be reused.`)) return;
    try {
      const result = await api(`/students/${encodeURIComponent(student.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ exit_reason: exitReason }),
      });
      notify(result.message);
      await loadStudents();
    } catch (error) {
      notify(error.message, true);
    }
  }
});

$("#studentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = $("#studentRecordId").value;
  const values = {
    full_name: $("#fullName").value,
    student_id: $("#studentUid").value.trim().toUpperCase(),
    class_id: $("#studentClass").value || null,
    gender: $("#studentGender").value,
    phone: $("#studentPhone").value,
    email: $("#studentEmail").value,
  };
  try {
    await api(id ? `/students/${encodeURIComponent(id)}` : "/students", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(values),
    });
    $("#studentDialog").close();
    notify(id ? "Student details updated." : "Student registered successfully.");
    await loadStudents();
  } catch (error) {
    $("#studentFormError").textContent = error.message;
    notify(error.message, "error", "Could not save student");
  }
});

$("#addClassButton").addEventListener("click", async () => {
  const className = prompt("Enter the new class or department name:");
  if (!className?.trim()) return;
  try {
    const created = await api("/classes", {
      method: "POST",
      body: JSON.stringify({ class_name: className.trim() }),
    });
    await loadClasses();
    $("#studentClass").value = created.id;
  } catch (error) {
    $("#studentFormError").textContent = error.message;
  }
});

$("#filterAttendance").addEventListener("click", () => loadAttendance().catch((error) => notify(error.message, true)));
$("#exportAttendance").addEventListener("click", () => downloadCsv("antende-attendance.csv", [
  ["Student", "Student ID / RFID UID", "Class", "Date", "Time", "Status"],
  ...attendanceRows.map((record) => [
    record.students.full_name, record.students.student_id,
    record.students.classes?.class_name || "", record.attendance_date, record.attendance_time, record.status,
  ]),
]));
$("#loadReport").addEventListener("click", () => loadReport().catch((error) => notify(error.message, true)));
$("#exportReport").addEventListener("click", () => downloadCsv("antende-report.csv", [
  ["Student", "Student ID / RFID UID", "Class", "Date", "Time", "Status"],
  ...reportRows.map((record) => [
    record.students.full_name, record.students.student_id,
    record.students.classes?.class_name || "", record.attendance_date, record.attendance_time, record.status,
  ]),
]));
$("#loadHistory").addEventListener("click", () => loadHistory().catch((error) => notify(error.message, true)));

$("#attendanceFrom").value = today();
$("#attendanceTo").value = today();
$("#reportDate").value = today();
if (adminKey) {
  api("/classes").then(async () => {
    const health = await api("/health");
    serverDate = health.date;
    $("#deviceIdLabel").textContent = health.deviceId;
    $("#attendanceFrom").value = serverDate;
    $("#attendanceTo").value = serverDate;
    $("#reportDate").value = serverDate;
    showApp();
    startScanNotifications();
    await navigate("dashboard");
  }).catch((error) => showLogin(error.message));
} else {
  showLogin();
}
