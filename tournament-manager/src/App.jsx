import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * TournamentManager (Google Sheets storage via Apps Script Web App)
 * - No custom backend server. Google Apps Script provides an HTTPS endpoint that reads/writes a Google Sheet.
 * - Shared across browsers/devices.
 *
 * REQUIRED ENV:
 *   VITE_SHEETS_API_URL = your deployed Apps Script Web App URL
 *
 * NOTE:
 * - Security is limited without real auth. Admin login is still hardcoded in the UI.
 * - If your Apps Script is deployed as "Anyone", anyone could call the endpoint.
 *   For better security, you can require an adminKey inside Apps Script (still not perfect).
 */

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "turnir123";

const API_URL = import.meta.env.VITE_SHEETS_API_URL;

const LS_KEYS = {
  admin: "tm_admin_session_v1",
};

function safeJsonParse(v, fallback) {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function sanitizeText(s) {
  return (s ?? "").toString().replace(/[\r\n]+/g, " ").trim();
}

function normalizeNeuronId(v) {
  return sanitizeText(v).toUpperCase().replace(/\s+/g, "");
}

function toMoneyEUR(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return String(value ?? "");
  return new Intl.NumberFormat("hr-HR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(n);
}

function asIntOrNaN(v) {
  if (v === "" || v === null || v === undefined) return NaN;
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.trunc(n);
}

function downloadTxt(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

/** Flexible date parsing -> normalized DD/MM/YY */
function parseDateFlexible(input) {
  const raw = sanitizeText(input);
  if (!raw) return { ok: false };
  const cleaned = raw
    .replace(/[^\d\/\.\-\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\.\/\-\s]+$/g, "");
  const parts = cleaned.split(/[\/\.\-\s]+/).filter(Boolean);
  if (parts.length !== 3) return { ok: false };
  const dd = Number(parts[0]);
  const mm = Number(parts[1]);
  let yy = Number(parts[2]);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yy)) return { ok: false };
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return { ok: false };
  if (String(parts[2]).length === 4) yy = yy % 100;
  else if (String(parts[2]).length === 1) yy = yy; // allow 6 -> 06
  else if (String(parts[2]).length !== 2) return { ok: false };
  const fullYear = 2000 + yy;
  const dt = new Date(fullYear, mm - 1, dd);
  if (dt.getFullYear() != fullYear || dt.getMonth() != mm - 1 || dt.getDate() != dd) return { ok: false };
  const norm = `${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${String(yy).padStart(2, "0")}`;
  return { ok: true, norm };
}
function normalizeDateInput(input) {
  const r = parseDateFlexible(input);
  return r.ok ? r.norm : "";
}

function isValidTimeHHMM(s) {
  const v = sanitizeText(s);
  if (!/^\d{2}:\d{2}$/.test(v)) return false;
  const [hh, mm] = v.split(":").map((x) => Number(x));
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

function formatDateLabel(v) {
  return v ? v : "—";
}
function formatTimeLabel(v) {
  return v ? v : "—";
}

/** API wrapper for Apps Script */
async function apiCall(action, payload = {}) {
  if (!API_URL) throw new Error("Missing VITE_SHEETS_API_URL");
  const body = { ...payload, action };
  const res = await fetch(API_URL, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  if (!json?.ok) throw new Error(json?.error || "Unknown API error");
  return json.data;
}

export default function App() {
  const [route, setRoute] = useState(() => {
    const m = window.location.hash.match(/^#\/event\/(.+)$/);
    return m ? { name: "event", id: m[1] } : { name: "home" };
  });

  const [admin, setAdmin] = useState(() => {
    const raw = localStorage.getItem(LS_KEYS.admin);
    const parsed = safeJsonParse(raw, { isAdmin: false });
    return !!parsed?.isAdmin;
  });

  const [events, setEvents] = useState([]);
  const [registrations, setRegistrations] = useState([]);
  const [subCount, setSubCount] = useState(0);

  const [toast, setToast] = useState(null); // {type, text}
  const [loading, setLoading] = useState(false);

  // admin login
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");

  // modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState("create"); // create|edit
  const [editingEvent, setEditingEvent] = useState(null);

  // registration form
  const [regFirst, setRegFirst] = useState("");
  const [regLast, setRegLast] = useState("");
  const [regNeuronId, setRegNeuronId] = useState("");
  const [regMsg, setRegMsg] = useState(null);

  // newsletter
  const [newsletterEmail, setNewsletterEmail] = useState("");

  useEffect(() => {
    function onHash() {
      const m = window.location.hash.match(/^#\/event\/(.+)$/);
      setRoute(m ? { name: "event", id: m[1] } : { name: "home" });
      setRegMsg(null);
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.admin, JSON.stringify({ isAdmin: admin, ts: Date.now() }));
  }, [admin]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const sortedEvents = useMemo(() => [...events], [events]);

  const currentEvent = useMemo(() => {
    if (route.name !== "event") return null;
    return events.find((e) => e.id === route.id) || null;
  }, [route, events]);

  async function refreshHomeData() {
    if (!API_URL) return;
    setLoading(true);
    try {
      const data = await apiCall("list_events");
      setEvents(Array.isArray(data) ? data : []);
      const c = await apiCall("sub_count");
      setSubCount(Number(c || 0));
    } catch (e) {
      setToast({ type: "err", text: String(e.message || e) });
    } finally {
      setLoading(false);
    }
  }

  async function refreshRegistrations(eventId) {
    if (!API_URL || !eventId) return;
    setLoading(true);
    try {
      const data = await apiCall("list_registrations", { eventId });
      setRegistrations(Array.isArray(data) ? data : []);
    } catch (e) {
      setToast({ type: "err", text: String(e.message || e) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshHomeData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (route.name !== "event") {
      setRegistrations([]);
      return;
    }
    refreshRegistrations(route.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  function goHome() {
    window.location.hash = "#/";
  }
  function openEvent(id) {
    window.location.hash = `#/event/${id}`;
  }

  function handleAdminLogin() {
    if (loginUser === ADMIN_USERNAME && loginPass === ADMIN_PASSWORD) {
      setAdmin(true);
      setLoginUser("");
      setLoginPass("");
      setToast({ type: "ok", text: "Admin prijava uspješna." });
      return;
    }
    setToast({ type: "err", text: "Neispravno korisničko ime ili lozinka." });
  }
  function handleAdminLogout() {
    setAdmin(false);
    setToast({ type: "info", text: "Admin odjavljen." });
  }

  function openCreate() {
    setModalMode("create");
    setEditingEvent(null);
    setModalOpen(true);
  }
  function openEdit(ev) {
    setModalMode("edit");
    setEditingEvent(ev);
    setModalOpen(true);
  }

  async function createEvent(payload) {
    setLoading(true);
    try {
      const ev = {
        id: uid("evt"),
        ...payload,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await apiCall("create_event", { event: ev });
      setToast({ type: "ok", text: "Događaj je objavljen." });
      await refreshHomeData();
    } catch (e) {
      setToast({ type: "err", text: String(e.message || e) });
    } finally {
      setLoading(false);
    }
  }

  async function updateEvent(eventId, patch) {
    setLoading(true);
    try {
      await apiCall("update_event", { eventId, patch: { ...patch, updatedAt: Date.now() } });
      setToast({ type: "ok", text: "Objava je ažurirana." });
      await refreshHomeData();
    } catch (e) {
      setToast({ type: "err", text: String(e.message || e) });
    } finally {
      setLoading(false);
    }
  }

  async function deleteEvent(eventId) {
    setLoading(true);
    try {
      await apiCall("delete_event", { eventId });
      if (route.name === "event" && route.id === eventId) goHome();
      setToast({ type: "info", text: "Događaj je obrisan." });
      await refreshHomeData();
    } catch (e) {
      setToast({ type: "err", text: String(e.message || e) });
    } finally {
      setLoading(false);
    }
  }

  async function submitRegistration() {
    setRegMsg(null);
    if (!currentEvent) return;

    const cap = asIntOrNaN(currentEvent.playerCap);
    if (Number.isFinite(cap) && cap > 0 && registrations.length >= cap) {
      setRegMsg({ type: "err", text: "Prijave su zatvorene (popunjen maksimalan broj igrača)." });
      return;
    }

    const fn = regFirst.trim();
    const ln = regLast.trim();
    const nid = normalizeNeuronId(regNeuronId);
    if (!fn || !ln || !nid) return setRegMsg({ type: "err", text: "Ime, prezime i Neuron ID su obavezni." });

    if (registrations.some((r) => normalizeNeuronId(r.neuronId) === nid)) {
      return setRegMsg({ type: "err", text: "Već si prijavljen s tim Neuron ID-em." });
    }

    setLoading(true);
    try {
      await apiCall("register", { eventId: currentEvent.id, registration: { firstName: fn, lastName: ln, neuronId: nid } });
      setRegMsg({ type: "ok", text: "Uspješno si prijavljen." });
      setRegFirst("");
      setRegLast("");
      setRegNeuronId("");
      await refreshRegistrations(currentEvent.id);
    } catch (e) {
      setRegMsg({ type: "err", text: String(e.message || e) });
    } finally {
      setLoading(false);
    }
  }

  async function submitUnregister() {
    setRegMsg(null);
    if (!currentEvent) return;
    const nid = normalizeNeuronId(regNeuronId);
    if (!nid) return setRegMsg({ type: "err", text: "Za odjavu je potreban Neuron ID." });

    setLoading(true);
    try {
      const removed = await apiCall("unregister", { eventId: currentEvent.id, neuronId: nid });
      if (!removed) setRegMsg({ type: "err", text: "Provjeri je li Neuron ID ispravan, nisi prijavljen." });
      else setRegMsg({ type: "ok", text: "Uspješno si odjavljen." });
      setRegNeuronId("");
      await refreshRegistrations(currentEvent.id);
    } catch (e) {
      setRegMsg({ type: "err", text: String(e.message || e) });
    } finally {
      setLoading(false);
    }
  }

  async function subscribeNewsletter() {
    const e = newsletterEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      setToast({ type: "err", text: "Unesi ispravnu e-mail adresu." });
      return;
    }
    setLoading(true);
    try {
      const status = await apiCall("subscribe", { email: e });
      if (status === "exists") setToast({ type: "info", text: "Već si pretplaćen." });
      else setToast({ type: "ok", text: "Pretplata uspješna." });
      setNewsletterEmail("");
      await refreshHomeData();
    } catch (err) {
      setToast({ type: "err", text: String(err.message || err) });
    } finally {
      setLoading(false);
    }
  }

  async function exportSubscribersTxt() {
    setLoading(true);
    try {
      const subs = await apiCall("list_subscribers");
      const lines = (subs || []).map((x) => x.email).filter(Boolean);
      downloadTxt("newsletter_subscribers.txt", lines.join("\n") + (lines.length ? "\n" : ""));
    } catch (e) {
      setToast({ type: "err", text: String(e.message || e) });
    } finally {
      setLoading(false);
    }
  }

  function exportRegistrationsTxt(event) {
    const regs = registrations || [];
    const lines = regs.map((r) => `${sanitizeText(r.firstName)}-${sanitizeText(r.lastName)}-${sanitizeText(r.neuronId)}`);
    const header = `${sanitizeText(event.title)} | ${formatDateLabel(event.date)} | ${sanitizeText(event.location)}\n`;
    const content = header + lines.join("\n") + (lines.length ? "\n" : "");
    const fnameBase = sanitizeText(event.title).replace(/[^a-z0-9\- _]+/gi, "_") || "turnir";
    downloadTxt(`${fnameBase}_prijave.txt`, content);
  }

  return (
    <div className="app">
      <header className="page-header">
        <div className="brand">CYBERARENA</div>
        <div className="page-title">{route.name === "home" ? "ACTIVE TOURNAMENTS" : "TOURNAMENT DETAILS"}</div>
        <div className="page-subtitle">{route.name === "home" ? "Select a tournament to register or view details" : "Read details and register"}</div>
        <div className="top-actions">
          {route.name === "event" ? (
            <button className="btn btn--ghost" onClick={goHome}>
              ← Back
            </button>
          ) : null}
          {admin ? (
            <button className="btn btn--ghost" onClick={handleAdminLogout}>
              Logout admin
            </button>
          ) : null}
        </div>
      </header>

      {!API_URL ? (
        <div className="toast toast--err">
          Nema API URL. Dodaj env varijablu: <b>VITE_SHEETS_API_URL</b> (Apps Script Web App URL).
        </div>
      ) : null}

      {toast ? <div className={`toast toast--${toast.type}`}>{toast.text}</div> : null}
      {loading ? <div className="toast toast--info">Syncing…</div> : null}

      {route.name === "home" ? (
        <>
          <section className="newsletter">
            <div className="newsletter__inner">
              <div className="newsletter__title">Newsletter</div>
              <div className="newsletter__subtitle">Upiši e-mail i dobit ćeš obavijest kada se objavi novi event.</div>
              <div className="newsletter__row">
                <input className="input" value={newsletterEmail} onChange={(e) => setNewsletterEmail(e.target.value)} placeholder="email@example.com" />
                <button className="btn" onClick={subscribeNewsletter} disabled={!API_URL}>
                  Subscribe
                </button>
              </div>
              <div className="newsletter__foot">
                Subscribers: <b>{subCount}</b>
              </div>
            </div>
          </section>

          <section className="events-area">
            {sortedEvents.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">⚡</div>
                <div className="empty-text">No tournaments available</div>
              </div>
            ) : (
              <div className="events-grid">
                {sortedEvents.map((e) => (
                  <div key={e.id} className="event-card-wrap">
                    <button className="event-card" onClick={() => openEvent(e.id)}>
                      <div className="event-card__image">{e.imageDataUrl ? <img src={e.imageDataUrl} alt={e.title} /> : <div className="img-placeholder" />}</div>
                      <div className="event-card__meta">
                        <div className="event-card__title">{e.title}</div>
                        <div className="event-card__date">{formatDateLabel(e.date)}</div>
                      </div>
                    </button>
                    {admin ? (
                      <button className="btn btn--small" onClick={() => openEdit(e)}>
                        Edit
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="admin-section">
            <div className="admin-box">
              <h3>ADMIN ACCESS</h3>

              {!admin ? (
                <div className="admin-login">
                  <input className="admin-input" value={loginUser} onChange={(e) => setLoginUser(e.target.value)} placeholder="Username" autoComplete="username" />
                  <input className="admin-input" value={loginPass} onChange={(e) => setLoginPass(e.target.value)} placeholder="Password" type="password" autoComplete="current-password" />
                  <button className="admin-button" onClick={handleAdminLogin}>
                    Enter
                  </button>
                </div>
              ) : (
                <div className="admin-logged">
                  <div className="admin-status">Admin je prijavljen ✅</div>
                  <div className="admin-actions-row">
                    <button className="admin-button" onClick={openCreate} disabled={!API_URL}>
                      + New event
                    </button>
                    <button className="btn btn--small" onClick={exportSubscribersTxt} disabled={!API_URL}>
                      Export subscribers
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <EventModal
            open={modalOpen}
            mode={modalMode}
            initialEvent={editingEvent}
            onClose={() => setModalOpen(false)}
            onCreate={async (payload) => {
              await createEvent(payload);
              setModalOpen(false);
            }}
            onUpdate={async (payload) => {
              if (!editingEvent?.id) return;
              await updateEvent(editingEvent.id, payload);
              setModalOpen(false);
            }}
            onDelete={async (id) => {
              if (!id) return;
              const ok = window.confirm("Obrisati ovaj događaj? Ova radnja je nepovratna.");
              if (!ok) return;
              await deleteEvent(id);
              setModalOpen(false);
            }}
          />
        </>
      ) : (
        <section className="detail-area">
          {!currentEvent ? (
            <div className="detail-card">
              <div className="detail-title">Event not found</div>
              <div className="detail-text">This event does not exist (or was removed).</div>
              <div className="detail-actions">
                <button className="btn" onClick={goHome}>
                  Back to home
                </button>
              </div>
            </div>
          ) : (
            (() => {
              const ev = currentEvent;
              const cap = asIntOrNaN(ev.playerCap);
              const capText = Number.isFinite(cap) && cap > 0 ? `${registrations.length}/${cap}` : `${registrations.length}/∞`;
              const capReached = Number.isFinite(cap) && cap > 0 && registrations.length >= cap;

              return (
                <div className="detail-grid">
                  <div className="detail-card">
                    <div className="detail-hero">{ev.imageDataUrl ? <img src={ev.imageDataUrl} alt={ev.title} /> : <div className="img-placeholder hero-placeholder" />}</div>

                    <div className="detail-content">
                      <div className="detail-title">{ev.title}</div>

                      <div className="detail-meta">
                        <div className="meta-pill">Date: {formatDateLabel(ev.date)}</div>
                        <div className="meta-pill">Location: {ev.location}</div>
                        <div className="meta-pill">Pre-reg: {toMoneyEUR(ev.preregFee)}</div>
                        <div className="meta-pill">Non-reg: {toMoneyEUR(ev.nonRegFee)}</div>
                        <div className="meta-pill">Players: {capText}</div>
                        <div className="meta-pill">Swiss: {ev.swissRounds || "—"}</div>
                        <div className="meta-pill">TopCut: {ev.topCut || "—"}</div>
                        <div className="meta-pill">Reg opens: {formatTimeLabel(ev.regStartTime)}</div>
                        <div className="meta-pill">Starts: {formatTimeLabel(ev.tournamentStartTime)}</div>
                        <div className="meta-pill">Pre-reg from: {formatDateLabel(ev.preregStartDate)}</div>
                        <div className="meta-pill">Pre-reg ends: {formatDateLabel(ev.preregEndDate)}</div>
                      </div>

                      <div className="detail-description">{ev.description || "—"}</div>

                      {ev.notes ? (
                        <div className="notes-box">
                          <div className="notes-title">Other notes</div>
                          <div className="notes-text">{ev.notes}</div>
                        </div>
                      ) : null}

                      {admin ? (
                        <div className="detail-actions">
                          <button className="btn btn--ghost" onClick={() => openEdit(ev)}>
                            Edit event
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="side-stack">
                    <div className="panel">
                      <div className="panel-title">Registration</div>
                      <div className="panel-subtitle">Fields marked with * are required.</div>

                      <div className="form">
                        <label className="label">* First name</label>
                        <input className="input" value={regFirst} onChange={(e) => setRegFirst(e.target.value)} placeholder="First name" />

                        <label className="label">* Last name</label>
                        <input className="input" value={regLast} onChange={(e) => setRegLast(e.target.value)} placeholder="Last name" />

                        <label className="label">* Neuron ID</label>
                        <input className="input" value={regNeuronId} onChange={(e) => setRegNeuronId(e.target.value)} placeholder="Neuron ID" />

                        <div className="dual-actions">
                          <button className="btn" onClick={submitRegistration} disabled={capReached || !API_URL}>
                            {capReached ? "Player cap reached" : "Register"}
                          </button>
                          <button className="btn btn--ghost" onClick={submitUnregister} disabled={!API_URL}>
                            Unregister
                          </button>
                        </div>

                        {capReached ? <div className="inline-alert inline-alert--err">Registrations are closed (player cap reached).</div> : null}
                        {regMsg ? <div className={`inline-alert inline-alert--${regMsg.type}`}>{regMsg.text}</div> : null}
                      </div>
                    </div>

                    {admin ? (
                      <div className="panel">
                        <div className="panel-head">
                          <div>
                            <div className="panel-title">Registrations</div>
                            <div className="panel-subtitle">
                              Admin only • Total: <b>{registrations.length}</b>
                            </div>
                          </div>
                          <button className="btn btn--small" onClick={() => exportRegistrationsTxt(ev)} disabled={registrations.length === 0}>
                            Export .txt
                          </button>
                        </div>

                        {registrations.length === 0 ? (
                          <div className="empty-mini">No registrations yet.</div>
                        ) : (
                          <div className="table-wrap">
                            <table className="table">
                              <thead>
                                <tr>
                                  <th>First</th>
                                  <th>Last</th>
                                  <th>Neuron ID</th>
                                  <th>Time</th>
                                </tr>
                              </thead>
                              <tbody>
                                {registrations.map((r) => (
                                  <tr key={r.id}>
                                    <td>{r.firstName}</td>
                                    <td>{r.lastName}</td>
                                    <td>{r.neuronId}</td>
                                    <td className="muted">{r.createdAt ? new Date(r.createdAt).toLocaleString("hr-HR") : "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })()
          )}

          <EventModal
            open={modalOpen}
            mode={modalMode}
            initialEvent={editingEvent}
            onClose={() => setModalOpen(false)}
            onCreate={async (payload) => {
              await createEvent(payload);
              setModalOpen(false);
            }}
            onUpdate={async (payload) => {
              if (!editingEvent?.id) return;
              await updateEvent(editingEvent.id, payload);
              setModalOpen(false);
            }}
            onDelete={async (id) => {
              if (!id) return;
              const ok = window.confirm("Obrisati ovaj događaj? Ova radnja je nepovratna.");
              if (!ok) return;
              await deleteEvent(id);
              setModalOpen(false);
            }}
          />
        </section>
      )}
    </div>
  );
}

/** ===== EVENT MODAL ===== */
function EventModal({ open, mode, initialEvent, onClose, onCreate, onUpdate, onDelete }) {
  const isEdit = mode === "edit";

  const [eventId, setEventId] = useState(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [location, setLocation] = useState("");
  const [preregFee, setPreregFee] = useState("");
  const [nonRegFee, setNonRegFee] = useState("");
  const [playerCap, setPlayerCap] = useState("");
  const [swissRounds, setSwissRounds] = useState("");
  const [topCut, setTopCut] = useState("");
  const [regStartTime, setRegStartTime] = useState("");
  const [tournamentStartTime, setTournamentStartTime] = useState("");
  const [preregStartDate, setPreregStartDate] = useState("");
  const [preregEndDate, setPreregEndDate] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [err, setErr] = useState("");

  const dropRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setErr("");
    setEventId(initialEvent?.id || null);
    setTitle(initialEvent?.title || "");
    setDate(initialEvent?.date || "");
    setLocation(initialEvent?.location || "");
    setPreregFee(initialEvent?.preregFee === 0 || initialEvent?.preregFee ? String(initialEvent.preregFee) : "");
    setNonRegFee(initialEvent?.nonRegFee === 0 || initialEvent?.nonRegFee ? String(initialEvent.nonRegFee) : "");
    setPlayerCap(initialEvent?.playerCap === 0 || initialEvent?.playerCap ? String(initialEvent.playerCap) : "");
    setSwissRounds(initialEvent?.swissRounds === 0 || initialEvent?.swissRounds ? String(initialEvent.swissRounds) : "");
    setTopCut(initialEvent?.topCut === 0 || initialEvent?.topCut ? String(initialEvent.topCut) : "");
    setRegStartTime(initialEvent?.regStartTime || "");
    setTournamentStartTime(initialEvent?.tournamentStartTime || "");
    setPreregStartDate(initialEvent?.preregStartDate || "");
    setPreregEndDate(initialEvent?.preregEndDate || "");
    setDescription(initialEvent?.description || "");
    setNotes(initialEvent?.notes || "");
    setImageDataUrl(initialEvent?.imageDataUrl || "");
  }, [open, initialEvent]);

  async function pickImage(file) {
    setErr("");
    if (!file) return;
    if (!file.type.startsWith("image/")) return setErr("Odaberi sliku (image/*).");
    if (file.size > 3 * 1024 * 1024) return setErr("Slika je prevelika (max 3MB).");
    const dataUrl = await fileToDataUrl(file);
    setImageDataUrl(dataUrl);
  }

  function onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList?.add("dropzone--active");
  }
  function onDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList?.remove("dropzone--active");
  }
  async function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList?.remove("dropzone--active");
    const file = e.dataTransfer?.files?.[0];
    await pickImage(file);
  }

  function submit() {
    setErr("");
    const t = title.trim();
    const dtNorm = normalizeDateInput(date);
    const loc = location.trim();

    if (!imageDataUrl) return setErr("Slika je obavezna.");
    if (!t) return setErr("Naziv događaja je obavezan.");
    if (!dtNorm) return setErr("Datum nije ispravan. Primjeri: 01/03/26, 01.03.2026., 1/3/26");
    if (!loc) return setErr("Mjesto događaja je obavezno.");

    if (preregFee === "") return setErr("PreRegistration Fee je obavezan.");
    if (nonRegFee === "") return setErr("Non registered players Fee je obavezan.");
    if (playerCap === "") return setErr("Player Cap je obavezan.");
    if (swissRounds === "") return setErr("Swiss rounds je obavezan.");
    if (topCut === "") return setErr("TopCut je obavezan.");

    if (!regStartTime) return setErr("Vrijeme Početak prijava je obavezno.");
    if (!isValidTimeHHMM(regStartTime)) return setErr("Vrijeme Početak prijava mora biti HH:MM (npr. 09:30).");

    if (!tournamentStartTime) return setErr("Vrijeme Početak turnira je obavezno.");
    if (!isValidTimeHHMM(tournamentStartTime)) return setErr("Vrijeme Početak turnira mora biti HH:MM (npr. 10:00).");

    const preStartNorm = normalizeDateInput(preregStartDate);
    if (!preStartNorm) return setErr("Datum Početak pretprijava nije ispravan (npr. 01/03/26).");

    const preEndNorm = normalizeDateInput(preregEndDate);
    if (!preEndNorm) return setErr("Datum Završetak pretprijava/odjava nije ispravan (npr. 09/03/26).");

    const preFeeNum = Number(preregFee);
    if (Number.isNaN(preFeeNum) || preFeeNum < 0) return setErr("PreRegistration Fee mora biti broj (0 ili više).");

    const nonFeeNum = Number(nonRegFee);
    if (Number.isNaN(nonFeeNum) || nonFeeNum < 0) return setErr("Non registered players Fee mora biti broj (0 ili više).");

    const capNum = asIntOrNaN(playerCap);
    if (!Number.isFinite(capNum) || capNum <= 0) return setErr("Player Cap mora biti cijeli broj (1 ili više).");

    const swissNum = asIntOrNaN(swissRounds);
    if (!Number.isFinite(swissNum) || swissNum <= 0) return setErr("Swiss rounds mora biti cijeli broj (1 ili više).");

    const top = sanitizeText(topCut);
    if (!top) return setErr("TopCut je obavezan.");

    const payload = {
      title: t,
      date: dtNorm,
      location: loc,
      preregFee: preFeeNum,
      nonRegFee: nonFeeNum,
      playerCap: capNum,
      swissRounds: swissNum,
      topCut: top,
      regStartTime: sanitizeText(regStartTime),
      tournamentStartTime: sanitizeText(tournamentStartTime),
      preregStartDate: preStartNorm,
      preregEndDate: preEndNorm,
      description: description.trim(),
      notes: notes.trim(),
      imageDataUrl,
    };

    if (isEdit) onUpdate(payload);
    else onCreate(payload);
  }

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <div className="modal-title">{isEdit ? "Edit event" : "Create event"}</div>
          <button className="btn btn--small btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modal-body">
          <div className="form-grid">
            <div className="form-row form-row--full">
              <div className="label">* Image (drag & drop)</div>
              <div ref={dropRef} className="dropzone" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} role="button" tabIndex={0}>
                {imageDataUrl ? (
                  <div className="dropzone__preview">
                    <img src={imageDataUrl} alt="Preview" />
                  </div>
                ) : (
                  <div className="dropzone__hint">Drag & drop image here or click to upload</div>
                )}
                <input className="dropzone__file" type="file" accept="image/*" onChange={(e) => pickImage(e.target.files?.[0])} />
              </div>
            </div>

            <div className="form-row form-row--full">
              <div className="label">* Event name</div>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event name" />
            </div>

            <div className="form-row">
              <div className="label">* Event date</div>
              <input
                className="input"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                onBlur={() => {
                  const n = normalizeDateInput(date);
                  if (n) setDate(n);
                }}
                placeholder="01/03/26 or 01.03.2026."
              />
            </div>

            <div className="form-row">
              <div className="label">* Event location</div>
              <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City / venue" />
            </div>

            <div className="form-row">
              <div className="label">* Vrijeme Početak prijava (HH:MM)</div>
              <input className="input" value={regStartTime} onChange={(e) => setRegStartTime(e.target.value)} placeholder="09:30" />
            </div>

            <div className="form-row">
              <div className="label">* Vrijeme Početak turnira (HH:MM)</div>
              <input className="input" value={tournamentStartTime} onChange={(e) => setTournamentStartTime(e.target.value)} placeholder="10:00" />
            </div>

            <div className="form-row">
              <div className="label">* Datum Početak pretprijava</div>
              <input
                className="input"
                value={preregStartDate}
                onChange={(e) => setPreregStartDate(e.target.value)}
                onBlur={() => {
                  const n = normalizeDateInput(preregStartDate);
                  if (n) setPreregStartDate(n);
                }}
                placeholder="01/02/26"
              />
            </div>

            <div className="form-row">
              <div className="label">* Datum Završetak pretprijava/odjava</div>
              <input
                className="input"
                value={preregEndDate}
                onChange={(e) => setPreregEndDate(e.target.value)}
                onBlur={() => {
                  const n = normalizeDateInput(preregEndDate);
                  if (n) setPreregEndDate(n);
                }}
                placeholder="09/02/26"
              />
            </div>

            <div className="form-row">
              <div className="label">* PreRegistration Fee (EUR)</div>
              <input className="input" inputMode="decimal" value={preregFee} onChange={(e) => setPreregFee(e.target.value)} placeholder="e.g. 10" />
            </div>

            <div className="form-row">
              <div className="label">* Non registered players Fee (EUR)</div>
              <input className="input" inputMode="decimal" value={nonRegFee} onChange={(e) => setNonRegFee(e.target.value)} placeholder="e.g. 15" />
            </div>

            <div className="form-row">
              <div className="label">* Player Cap</div>
              <input className="input" inputMode="numeric" value={playerCap} onChange={(e) => setPlayerCap(e.target.value)} placeholder="e.g. 64" />
            </div>

            <div className="form-row">
              <div className="label">* Swiss rounds</div>
              <input className="input" inputMode="numeric" value={swissRounds} onChange={(e) => setSwissRounds(e.target.value)} placeholder="e.g. 6" />
            </div>

            <div className="form-row">
              <div className="label">* TopCut</div>
              <input className="input" value={topCut} onChange={(e) => setTopCut(e.target.value)} placeholder='e.g. "8" or "Top 8"' />
            </div>

            <div className="form-row form-row--full">
              <div className="label">Description</div>
              <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Rules, prizes, schedule, contact..." />
            </div>

            <div className="form-row form-row--full">
              <div className="label">Other notes</div>
              <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional notes..." />
            </div>

            {err ? (
              <div className="form-row form-row--full">
                <div className="inline-alert inline-alert--err">{err}</div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="modal-foot">
          <div className="hint">Fields marked with * are required.</div>
          <div className="modal-actions">
            {isEdit ? (
              <button className="btn btn--ghost btn--danger" onClick={() => onDelete?.(eventId)}>
                Delete
              </button>
            ) : null}

            <button className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" onClick={submit}>
              {isEdit ? "Save" : "Publish"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
