# antende

RFID-based student registration and attendance monitoring using an ESP32, RC522 reader, Express API, Supabase database, and responsive browser dashboard.

## Requirements

- Node.js 20+
- A Supabase project
- ESP32 DevKit, RC522, RFID cards, two LEDs, 220 Ω resistors, and an active buzzer
- Arduino IDE with the **MFRC522** and **ArduinoJson** libraries installed
- ArduinoJson 6 or newer

## 1. Set up Supabase

1. In Supabase, open **SQL Editor → New query**, paste the contents of [`supabase/schema.sql`](./supabase/schema.sql), and click **Run**.
   If the database was already set up, run the updated schema again to enable finished/dropped statuses and RFID card reuse.
2. The project URL is already filled into `.env.example`. For a local presentation with RLS disabled, the server uses the existing publishable key in `SUPABASE_KEY`. The key is public by design, but disabling RLS can expose table data.
3. The supplied schema enables RLS. To use the publishable key for a disposable presentation database, run this in Supabase SQL Editor after applying the schema:

   ```sql
   alter table public.classes disable row level security;
   alter table public.students disable row level security;
   alter table public.attendance disable row level security;
   alter table public.registration_requests disable row level security;
   ```

   These statements are for local testing only. Do not use this configuration for real student records.

## 2. Run the web app and API

From the project directory:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and set:

- `SUPABASE_KEY` to the existing publishable key for a presentation database with RLS disabled. If you keep RLS enabled, use a server-only `SUPABASE_SERVICE_ROLE_KEY` instead.
- A long, random `ADMIN_API_KEY` and a different `DEVICE_API_KEY`
- `ATTENDANCE_TIME_ZONE` to an IANA timezone, e.g. `Africa/Nairobi`
- `DEVICE_ID` (defaults to `esp32-01`)

Generate distinct local API keys in PowerShell (copy each output into its matching `.env` value):

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep `.env` excluded from git. Never put a Supabase Secret/service_role key in browser code or firmware.

### Quick setup on Windows

Alternatively, run `.\start-local.ps1` in PowerShell from the project folder. It asks for your publishable key in a masked local prompt, generates separate administrator/device keys, writes the ignored `.env` file, and starts the server. Save the administrator key printed in that terminal for dashboard sign-in. Keep the terminal open while testing; use `Ctrl+C` to stop the server.

Start the application:

```powershell
npm start
```

Open `http://localhost:3000` and sign in with `ADMIN_API_KEY`. The dashboard uses live API/database data. Never commit `.env`.

## Deploy on Render

The root [`render.yaml`](./render.yaml) configures a free Render web service using the existing `npm start` command. The free service can sleep after 15 minutes without inbound traffic; its first request after sleeping may take about a minute. Choose an always-on paid instance in Render if the ESP32 must reach the API without that delay.

1. Apply [`supabase/schema.sql`](./supabase/schema.sql) to your Supabase project if you have not already.
2. Push this project to a GitHub, GitLab, or Bitbucket repository. Keep `.env` and device credentials out of the repository; `.env` is ignored by `.gitignore`.
3. In Render, choose **New → Blueprint**, connect the repository, and deploy the `render.yaml` Blueprint.
4. When prompted, set `SUPABASE_URL` and `SUPABASE_KEY` in Render. For this disposable test setup, use the Supabase publishable key and disable RLS on the four application tables by running this in the Supabase SQL Editor:

   ```sql
   alter table public.classes disable row level security;
   alter table public.students disable row level security;
   alter table public.attendance disable row level security;
   alter table public.registration_requests disable row level security;
   ```

   This makes the test data accessible to anyone with the public key. Do not use this setup with real student records. For real data, keep RLS enabled and set a server-only service-role/secret key in Render instead; never put that key in the browser or ESP32 firmware. Render generates separate `ADMIN_API_KEY` and `DEVICE_API_KEY` values.
5. After deployment, open the service URL and sign in using `ADMIN_API_KEY` from the Render environment settings. Before flashing the ESP32, set the Wi-Fi credentials, `DEVICE_API_KEY` from Render, and the trusted certificate in `ROOT_CA_CERT` at the top of the sketch. The local `.env` device key does not match the Render-generated key.

## 3. Wire and flash the ESP32

Follow [`HARDWARE_CONNECTIONS.md`](./HARDWARE_CONNECTIONS.md). Configure `WIFI_SSID` and `WIFI_PASSWORD` at the top of `firmware/antende_esp32/antende_esp32.ino`. For Render, keep `API_BASE_URL` as `https://antende.onrender.com` and copy `DEVICE_API_KEY` from the Render environment settings—not from local `.env`. For local development, set `API_BASE_URL` to your computer's LAN IP and use the local `.env` device key. Set `ROOT_CA_CERT` to the trusted certificate for HTTPS; the firmware refuses unverified HTTPS connections. Do not commit the sketch after adding real Wi-Fi credentials, API keys, or certificates.

For local development, the ESP32 and computer must be on the same Wi-Fi network. Set `API_BASE_URL` to the computer's LAN address, such as `http://192.168.1.10:3000` (not `localhost`). Allow inbound connections to the selected port in the computer's firewall if needed. Plain HTTP is only appropriate for a trusted local development network. For a public deployment, use HTTPS and configure the trusted root certificate in `ROOT_CA_CERT`; the firmware refuses HTTPS connections without a certificate.

## Enrollment and attendance workflow

1. In **Students**, choose **Register student**, enter the profile and class, then select **Scan card**.
2. Tap a card on the connected ESP32 reader. While an enrollment request is pending, the device sends the UID to the enrollment endpoint rather than recording attendance. The dashboard fills in the UID and shows whether the card is new, already assigned, or available for reuse; saving the profile still checks that the UID is not assigned to another active student.
3. For normal scans, the ESP32 sends the UID to `POST /api/attendance/scan`. Only registered, active students are accepted. The dashboard shows live pop-up notifications for successful check-ins, duplicate attendance, and unknown or inactive cards. The API writes a daily attendance session (`daily-YYYY-MM-DD`) in the configured timezone; a database unique constraint prevents a second entry for the same student that day.
4. The device signals success only after the server confirms the insert. Unknown cards, duplicate scans, and network errors have distinct feedback. Offline scans are not queued or falsely confirmed.

Attendance timestamps use UTC in `created_at`; `attendance_date` and `attendance_time` use `ATTENDANCE_TIME_ZONE`. A daily session is the configured duplicate-prevention boundary. In **Students**, mark a student **Finished** or **Dropped** when they leave. Their profile and attendance history remain, while their RFID card can be assigned to a new active student. Existing inactive profiles without an exit reason remain labeled **Inactive**.

## API reference

Admin endpoints require `Authorization: Bearer <ADMIN_API_KEY>`. Device endpoints require `Authorization: Bearer <DEVICE_API_KEY>`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Server status, timezone, and device ID |
| GET / POST | `/api/classes` | List or create classes |
| GET / POST | `/api/students` | Search/list students or register a student |
| GET / PUT / DELETE | `/api/students/:id` | View/update or mark finished/dropped; preserves history and releases the RFID UID for reuse |
| POST | `/api/registration/scan-requests` | Start a two-minute card enrollment scan (admin) |
| GET | `/api/registration/scan-requests/:id` | Poll enrollment scan status (admin) |
| GET | `/api/device/commands?deviceId=esp32-01` | Poll for pending enrollment mode (device) |
| POST | `/api/device/registration-scans` | Submit a UID for the pending enrollment request (device) |
| GET | `/api/scan-notifications?after=...` | Poll recent attendance scan outcomes (admin) |
| POST | `/api/attendance/scan` | Validate a card and record attendance (device) |
| GET | `/api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD&classId=...` | Filter attendance (admin) |
| GET | `/api/reports/daily?date=YYYY-MM-DD` | Daily dashboard totals and records |
| GET | `/api/reports/summary?period=daily\|weekly\|monthly&date=YYYY-MM-DD` | Summary, percentages, and detailed records |
| GET | `/api/reports/student/:id` | Individual attendance history |

The frontend includes searchable student management, class filtering, attendance monitoring, daily/weekly/monthly-to-date summaries, individual history, and Excel-compatible CSV export.

## Verification

```powershell
npm run check
```

The ESP32 serial monitor runs at 115200 baud and reports UID scans, server outcomes, and connectivity errors.
