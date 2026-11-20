require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const requiredEnvironment = [
  "SUPABASE_URL",
  "ADMIN_API_KEY",
  "DEVICE_API_KEY",
];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseKey) missingEnvironment.push("SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY");

if (missingEnvironment.length) {
  console.error(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 3000);
const deviceId = process.env.DEVICE_ID || "esp32-01";
const timeZone = process.env.ATTENDANCE_TIME_ZONE || "UTC";
const scanNotifications = [];
let scanNotificationId = 0;
const maxScanNotifications = 100;
try {
  new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
} catch {
  console.error(`Invalid ATTENDANCE_TIME_ZONE: ${timeZone}`);
  process.exit(1);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  supabaseKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

function isAuthorized(expectedKey) {
  return (req, res, next) => {
    const supplied = req.get("authorization") || "";
    const token = supplied.startsWith("Bearer ") ? supplied.slice(7) : "";
    const expected = Buffer.from(expectedKey);
    const actual = Buffer.from(token);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).json({ error: "Unauthorized. Check the API key and try again." });
    }
    return next();
  };
}

const requireAdmin = isAuthorized(process.env.ADMIN_API_KEY);
const requireDevice = isAuthorized(process.env.DEVICE_API_KEY);

function errorResponse(res, error, message) {
  console.error(message, error);
  return res.status(500).json({ error: message });
}

function validationError(res, message) {
  return res.status(400).json({ error: message });
}

function validUid(value) {
  return typeof value === "string" && /^[0-9A-Fa-f]{4,20}$/.test(value);
}

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function recordScanNotification(notification) {
  scanNotifications.push({ id: ++scanNotificationId, ...notification });
  if (scanNotifications.length > maxScanNotifications) scanNotifications.shift();
}

function isDate(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function periodRange(period, date) {
  if (period === "daily") return { from: date, to: date };
  if (period === "weekly") {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    return { from: shiftDate(date, -mondayOffset), to: date };
  }
  if (period === "monthly") {
    const from = `${date.slice(0, 7)}-01`;
    return { from, to: date };
  }
  return null;
}

function studentFields(body) {
  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const uid = typeof body.student_id === "string" ? body.student_id.trim().toUpperCase() : "";
  if (!fullName || fullName.length > 120) {
    return { error: "Full name is required and must be 120 characters or fewer." };
  }
  if (!validUid(uid)) {
    return { error: "Enter a valid RFID UID (4 to 20 hexadecimal characters)." };
  }
  if (body.class_id && typeof body.class_id !== "string") {
    return { error: "Choose a valid class." };
  }
  for (const field of ["gender", "phone", "email"]) {
    if (body[field] != null && typeof body[field] !== "string") {
      return { error: `${field} must be text.` };
    }
  }
  const email = body.email ? body.email.trim() : null;
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return { error: "Enter a valid email address." };
  }
  return {
    values: {
      full_name: fullName,
      student_id: uid,
      class_id: body.class_id || null,
      gender: body.gender?.trim() || null,
      phone: body.phone?.trim() || null,
      email,
    },
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timeZone, deviceId, date: localDate() });
});

app.get("/api/classes", requireAdmin, async (_req, res) => {
  const { data, error } = await supabase.from("classes")
    .select("id,class_name,description")
    .order("class_name");
  if (error) return errorResponse(res, error, "Could not load classes.");
  return res.json(data);
});

app.post("/api/classes", requireAdmin, async (req, res) => {
  const className = typeof req.body.class_name === "string" ? req.body.class_name.trim() : "";
  if (!className || className.length > 100) {
    return validationError(res, "Class name is required and must be 100 characters or fewer.");
  }
  const description = typeof req.body.description === "string"
    ? req.body.description.trim() || null
    : null;
  const { data, error } = await supabase.from("classes")
    .insert({ class_name: className, description })
    .select("id,class_name,description")
    .single();
  if (error?.code === "23505") {
    return res.status(409).json({ error: "That class already exists." });
  }
  if (error) return errorResponse(res, error, "Could not create class.");
  return res.status(201).json(data);
});

app.get("/api/students", requireAdmin, async (req, res) => {
  let query = supabase.from("students")
    .select("id,student_id,full_name,gender,phone,email,registration_date,active_status,exit_reason,class_id,classes(id,class_name)")
    .order("full_name")
    .limit(1000);
  if (typeof req.query.search === "string" && req.query.search.trim()) {
    const search = req.query.search.trim().replace(/[^a-zA-Z0-9\s@_-]/g, "");
    query = query.or(`full_name.ilike.%${search}%,student_id.ilike.%${search}%`);
  }
  if (typeof req.query.classId === "string" && req.query.classId) {
    query = query.eq("class_id", req.query.classId);
  }
  const { data, error } = await query;
  if (error) return errorResponse(res, error, "Could not load students.");
  return res.json(data);
});

app.get("/api/students/:id", requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from("students")
    .select("id,student_id,full_name,gender,phone,email,registration_date,active_status,exit_reason,class_id,classes(id,class_name)")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return errorResponse(res, error, "Could not load student.");
  if (!data) return res.status(404).json({ error: "Student not found." });
  return res.json(data);
});

app.post("/api/students", requireAdmin, async (req, res) => {
  const result = studentFields(req.body);
  if (result.error) return validationError(res, result.error);
  const { data, error } = await supabase.from("students")
    .insert({ ...result.values, registration_date: localDate() })
    .select("id,student_id,full_name,gender,phone,email,registration_date,active_status,exit_reason,class_id,classes(id,class_name)")
    .single();
  if (error?.code === "23505") {
    return res.status(409).json({ error: "This RFID UID is already assigned to a student." });
  }
  if (error) return errorResponse(res, error, "Could not register student.");
  return res.status(201).json(data);
});

app.put("/api/students/:id", requireAdmin, async (req, res) => {
  const result = studentFields(req.body);
  if (result.error) return validationError(res, result.error);
  if (req.body.active_status != null && typeof req.body.active_status !== "boolean") {
    return validationError(res, "active_status must be true or false.");
  }
  const values = {
    ...result.values,
    ...(req.body.active_status == null ? {} : { active_status: req.body.active_status }),
    ...(req.body.active_status === true ? { exit_reason: null } : {}),
  };
  const { data, error } = await supabase.from("students")
    .update(values)
    .eq("id", req.params.id)
    .select("id,student_id,full_name,gender,phone,email,registration_date,active_status,exit_reason,class_id,classes(id,class_name)")
    .maybeSingle();
  if (error?.code === "23505") {
    return res.status(409).json({ error: "This RFID UID is already assigned to another student." });
  }
  if (error) return errorResponse(res, error, "Could not update student.");
  if (!data) return res.status(404).json({ error: "Student not found." });
  return res.json(data);
});

app.delete("/api/students/:id", requireAdmin, async (req, res) => {
  const exitReason = req.body?.exit_reason;
  if (!["finished", "dropped"].includes(exitReason)) {
    return validationError(res, "Choose whether the student finished or dropped their studies.");
  }
  const { data, error } = await supabase.from("students")
    .update({ active_status: false, exit_reason: exitReason })
    .eq("id", req.params.id)
    .select("id,student_id,full_name,active_status,exit_reason")
    .maybeSingle();
  if (error) return errorResponse(res, error, "Could not update student status.");
  if (!data) return res.status(404).json({ error: "Student not found." });
  const label = exitReason === "finished" ? "finished their studies" : "dropped their studies";
  return res.json({
    ...data,
    message: `Student marked as having ${label}; attendance history was preserved and the RFID card can be reused.`,
  });
});

app.post("/api/registration/scan-requests", requireAdmin, async (_req, res) => {
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from("registration_requests")
    .insert({ device_id: deviceId, status: "pending", expires_at: expiresAt })
    .select("id,status,expires_at")
    .single();
  if (error) return errorResponse(res, error, "Could not start RFID card scan.");
  return res.status(201).json(data);
});

app.get("/api/registration/scan-requests/:id", requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from("registration_requests")
    .select("id,status,uid,expires_at")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return errorResponse(res, error, "Could not check RFID scan status.");
  if (!data) return res.status(404).json({ error: "Scan request not found." });
  if (data.status === "pending" && Date.parse(data.expires_at) <= Date.now()) {
    const { error: expiryError } = await supabase.from("registration_requests")
      .update({ status: "expired" })
      .eq("id", data.id)
      .eq("status", "pending");
    if (expiryError) return errorResponse(res, expiryError, "Could not expire RFID scan request.");
    data.status = "expired";
  }
  return res.json(data);
});

app.get("/api/device/commands", requireDevice, async (req, res) => {
  const requestedDevice = typeof req.query.deviceId === "string" ? req.query.deviceId : "";
  if (requestedDevice !== deviceId) return validationError(res, "Unknown device ID.");
  const { data, error } = await supabase.from("registration_requests")
    .select("id")
    .eq("device_id", deviceId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) return errorResponse(res, error, "Could not load device commands.");
  return res.json({ registrationRequestId: data?.id || null });
});

app.post("/api/device/registration-scans", requireDevice, async (req, res) => {
  const { requestId, uid } = req.body;
  if (typeof requestId !== "string" || !validUid(uid)) {
    return validationError(res, "A scan request ID and valid RFID UID are required.");
  }
  const { data, error } = await supabase.from("registration_requests")
    .update({ status: "scanned", uid: uid.toUpperCase(), scanned_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("device_id", deviceId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("id,status,uid")
    .maybeSingle();
  if (error) return errorResponse(res, error, "Could not save RFID scan.");
  if (!data) return res.status(409).json({ error: "Scan request expired or was already completed." });
  return res.json({ status: "scanned", uid: data.uid });
});

app.get("/api/scan-notifications", requireAdmin, (req, res) => {
  if (req.query.after === undefined) {
    return res.json({ notifications: [], latestId: scanNotificationId });
  }
  const after = Number(req.query.after);
  if (!Number.isSafeInteger(after) || after < 0) {
    return validationError(res, "The notification cursor must be a non-negative integer.");
  }
  const notifications = scanNotifications.filter((item) => item.id > after);
  return res.json({ notifications, latestId: scanNotificationId });
});

app.post("/api/attendance/scan", requireDevice, async (req, res) => {
  const uid = typeof req.body.uid === "string" ? req.body.uid.trim().toUpperCase() : "";
  if (!validUid(uid)) return validationError(res, "A valid RFID UID is required.");

  const { data: student, error: studentError } = await supabase.from("students")
    .select("id,student_id,full_name,active_status")
    .eq("student_id", uid)
    .eq("active_status", true)
    .maybeSingle();
  if (studentError) return errorResponse(res, studentError, "Could not validate RFID card.");
  if (!student || !student.active_status) {
    recordScanNotification({ status: "unknown", uid });
    return res.json({ status: "unknown", message: "Card is not assigned to an active student." });
  }

  const scannedAt = new Date();
  const attendanceDate = localDate(scannedAt);
  const { data: attendance, error } = await supabase.from("attendance")
    .insert({
      student_id: student.id,
      session_id: `daily-${attendanceDate}`,
      attendance_date: attendanceDate,
      attendance_time: localTime(scannedAt),
      status: "present",
      device_id: deviceId,
    })
    .select("id,attendance_date,attendance_time,status")
    .single();
  if (error?.code === "23505") {
    recordScanNotification({
      status: "duplicate",
      student: { student_id: student.student_id, full_name: student.full_name },
    });
    return res.json({
      status: "duplicate",
      message: "Attendance has already been recorded for this student today.",
      student: { student_id: student.student_id, full_name: student.full_name },
    });
  }
  if (error) return errorResponse(res, error, "Could not save attendance.");
  recordScanNotification({
    status: "accepted",
    student: { student_id: student.student_id, full_name: student.full_name },
  });
  return res.json({
    status: "accepted",
    message: "Attendance recorded.",
    student: { student_id: student.student_id, full_name: student.full_name },
    attendance,
  });
});

async function getAttendanceRecords({ from, to, classId, studentUid }) {
  let query = supabase.from("attendance")
    .select("id,attendance_date,attendance_time,status,session_id,device_id,created_at,students!inner(id,student_id,full_name,class_id,active_status,classes(id,class_name))")
    .order("attendance_date", { ascending: false })
    .order("attendance_time", { ascending: false })
    .limit(1000);
  if (from) query = query.gte("attendance_date", from);
  if (to) query = query.lte("attendance_date", to);
  if (classId) query = query.eq("students.class_id", classId);
  if (studentUid) query = query.eq("students.student_id", studentUid);
  return query;
}

app.get("/api/attendance", requireAdmin, async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if ((from && !isDate(from)) || (to && !isDate(to))) {
    return validationError(res, "Use valid dates in YYYY-MM-DD format.");
  }
  const classId = typeof req.query.classId === "string" ? req.query.classId : "";
  const studentUid = typeof req.query.studentUid === "string"
    ? req.query.studentUid.trim().toUpperCase()
    : "";
  if (studentUid && !validUid(studentUid)) return validationError(res, "Invalid student RFID UID.");
  const { data, error } = await getAttendanceRecords({ from, to, classId, studentUid });
  if (error) return errorResponse(res, error, "Could not load attendance records.");
  return res.json(data);
});

app.get("/api/reports/daily", requireAdmin, async (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : localDate();
  if (!isDate(date)) return validationError(res, "Use a valid date in YYYY-MM-DD format.");
  const [
    { count, error: studentError },
    { data: records, error: attendanceError },
  ] = await Promise.all([
    supabase.from("students").select("id", { count: "exact", head: true })
      .eq("active_status", true).lte("registration_date", date),
    getAttendanceRecords({ from: date, to: date }),
  ]);
  if (studentError) return errorResponse(res, studentError, "Could not count registered students.");
  if (attendanceError) return errorResponse(res, attendanceError, "Could not load daily attendance.");
  const activeRecords = records.filter((record) => record.students.active_status);
  const present = new Set(activeRecords.map((record) => record.students.id)).size;
  const total = count || 0;
  return res.json({
    date,
    timeZone,
    totalStudents: total,
    present,
    absent: Math.max(0, total - present),
    attendancePercentage: total ? Math.round((present / total) * 10000) / 100 : 0,
    records: activeRecords,
  });
});

app.get("/api/reports/summary", requireAdmin, async (req, res) => {
  const period = typeof req.query.period === "string" ? req.query.period : "daily";
  const date = typeof req.query.date === "string" ? req.query.date : localDate();
  if (!["daily", "weekly", "monthly"].includes(period)) {
    return validationError(res, "Period must be daily, weekly, or monthly.");
  }
  if (!isDate(date)) return validationError(res, "Use a valid date in YYYY-MM-DD format.");
  const range = periodRange(period, date);
  const [studentsResult, attendanceResult] = await Promise.all([
    supabase.from("students").select("id,registration_date")
      .eq("active_status", true).lte("registration_date", range.to),
    getAttendanceRecords(range),
  ]);
  if (studentsResult.error) {
    return errorResponse(res, studentsResult.error, "Could not count registered students.");
  }
  if (attendanceResult.error) {
    return errorResponse(res, attendanceResult.error, "Could not load report attendance.");
  }
  const activeStudents = studentsResult.data || [];
  const expected = activeStudents.reduce((total, student) => {
    const firstEligibleDate = student.registration_date > range.from
      ? student.registration_date
      : range.from;
    const eligibleDays = firstEligibleDate > range.to
      ? 0
      : Math.floor(
        (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${firstEligibleDate}T00:00:00Z`)) / 86400000,
      ) + 1;
    return total + eligibleDays;
  }, 0);
  const presentCount = attendanceResult.data.filter((record) => record.students.active_status).length;
  return res.json({
    period,
    date,
    from: range.from,
    to: range.to,
    timeZone,
    activeStudents: activeStudents.length,
    attendanceCount: presentCount,
    absentCount: Math.max(0, expected - presentCount),
    expectedAttendance: expected,
    attendancePercentage: expected ? Math.round((presentCount / expected) * 10000) / 100 : 0,
    records: attendanceResult.data.filter((record) => record.students.active_status),
  });
});

app.get("/api/reports/student/:id", requireAdmin, async (req, res) => {
  const { data: student, error: studentError } = await supabase.from("students")
    .select("id,student_id,full_name,class_id,classes(class_name)")
    .eq("id", req.params.id)
    .maybeSingle();
  if (studentError) return errorResponse(res, studentError, "Could not load student history.");
  if (!student) return res.status(404).json({ error: "Student not found." });
  const { data, error } = await getAttendanceRecords({ studentUid: student.student_id });
  if (error) return errorResponse(res, error, "Could not load student attendance history.");
  return res.json({ student, records: data });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.use(express.static(path.join(__dirname, "public")));
app.use((error, _req, res, _next) => {
  console.error("Unhandled request error:", error);
  if (res.headersSent) return;
  return res.status(500).json({ error: "An unexpected server error occurred." });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`antende listening on port ${port} (${timeZone})`);
});
