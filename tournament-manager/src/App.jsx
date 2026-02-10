import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Tournament registration app (client-only)
 * - Public: see published events (preview: image + name + date), open event, register/unregister
 * - Admin (hardcoded): login at bottom of home, create/edit event (image drag&drop),
 *   view registrations, export .txt (format: ime-prezime-neuronId)
 *
 * Storage: localStorage (events + admin session). Images are stored as DataURL (base64).
 *
 * Changes (v5):
 * - Date input format: DD/MM/YY (stored as DD/MM/YY string)
 * - Registration fields: First name*, Last name*, Neuron ID* (email removed)
 * - Unregister flow: enter Neuron ID, click "Unregister" -> removes matching entry if exists
 * - Admin adds:
 *   - Time: Registration start (Vrijeme Početak prijava)
 *   - Time: Tournament start (Vrijeme Početak turnira)
 *   - Date: Pre-reg start (Datum Početak pretprijava)
 *   - Date: Pre-reg end/cancel (Datum Završetak pretprijava/odjava)
 */

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "adminpassword";

const LS_KEYS = {
  events: "tm_events_v5",
  admin: "tm_admin_session_v1",
  subscribers: "tm_subscribers_v1",
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


function buildNewsletterMailto(event, subscribers) {
  const toList = (subscribers || []).filter(Boolean).map((s) => s.trim().toLowerCase());
  if (!event || toList.length === 0) return "";

  const subject = `Novi event: ${sanitizeText(event.title)} (${formatDateLabel(event.date)})`;

  const lines = [
    `Objavljen je novi event: ${sanitizeText(event.title)}`,
    ``,
    `Datum: ${formatDateLabel(event.date)}`,
    `Lokacija: ${sanitizeText(event.location)}`,
    `PreRegistration Fee: ${toMoneyEUR(event.preregFee)}`,
    `Non-registered Fee: ${toMoneyEUR(event.nonRegFee)}`,
    `Player cap: ${event.playerCap || "—"}`,
    `Swiss rounds: ${event.swissRounds || "—"}`,
    `TopCut: ${event.topCut || "—"}`,
    `Početak prijava: ${formatTimeLabel(event.regStartTime)}`,
    `Početak turnira: ${formatTimeLabel(event.tournamentStartTime)}`,
    `Pretprijave od: ${formatDateLabel(event.preregStartDate)}`,
    `Pretprijave/odjava do: ${formatDateLabel(event.preregEndDate)}`,
    ``,
    `Detalji:`,
    sanitizeText(event.description || "—"),
    ``,
    event.notes ? `Napomene: ${sanitizeText(event.notes)}` : "",
    ``,
    `Link: ${window.location.origin}${window.location.pathname}#/event/${event.id}`,
  ].filter((x) => x !== "");

  const body = lines.join("\n");

  // Use BCC so recipients don't see each other (email client must support it)
  return `mailto:?bcc=${encodeURIComponent(toList.join(","))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
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

function normalizeNeuronId(v) {
  return sanitizeText(v).toUpperCase().replace(/\s+/g, "");
}

function parseDateFlexible(input) {
  // Accepts: 01/03/26, 1/3/26, 01.03.2026., 01-03-2026, 01 03 26, etc.
  const raw = sanitizeText(input);
  if (!raw) return { ok: false, reason: "empty" };

  const cleaned = raw
    .replace(/[^\d\/\.\-\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\.\/\-\s]+$/g, "");
  const parts = cleaned.split(/[\/\.\-\s]+/).filter(Boolean);
  if (parts.length !== 3) return { ok: false, reason: "format" };

  const dd = Number(parts[0]);
  const mm = Number(parts[1]);
  let yy = Number(parts[2]);

  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yy)) return { ok: false, reason: "nan" };
  if (mm < 1 || mm > 12) return { ok: false, reason: "month" };
  if (dd < 1 || dd > 31) return { ok: false, reason: "day" };

  // Year: allow 2-digit or 4-digit
  if (String(parts[2]).length === 4) {
    yy = yy % 100;
  } else if (String(parts[2]).length === 2) {
    // ok
  } else if (String(parts[2]).length === 1) {
    // ok (6 -> 06)
  } else {
    return { ok: false, reason: "year" };
  }

  const fullYear = 2000 + yy;
  const dt = new Date(fullYear, mm - 1, dd);
  if (dt.getFullYear() !== fullYear || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) {
    return { ok: false, reason: "invalid" };
  }

  const norm = `${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${String(yy).padStart(2, "0")}`;
  return { ok: true, norm, dd, mm, yy };
}

function normalizeDateInput(input) {
  const r = parseDateFlexible(input);
  return r.ok ? r.norm : "";
}

function isValidTimeHHMM(s) {
  const v = sanitizeText(s);
  if (!/^\d{2}:\d{2}$/.test(v)) return false;
  const [hh, mm] = v.split(":").map((x) => Number(x));
  if (hh < 0 || hh > 23) return false;
  if (mm < 0 || mm > 59) return false;
  return true;
}


function validateEmail(v) {
  const s = (v || "").trim().toLowerCase();
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function formatDateLabel(v) {
  return v ? v : "—";
}

function formatTimeLabel(v) {
  return v ? v : "—";
}

function normalizeLegacyEventFields(ev) {
  if (!ev) return ev;

  const preregFee =
    ev.preregFee ?? ev.preRegistrationFee ?? ev.preRegFee ?? ev.fee ?? ev.price ?? 0;
  const nonRegFee =
    ev.nonRegFee ?? ev.nonRegisteredFee ?? ev.nonRegisteredPlayersFee ?? preregFee;

  // If older date was YYYY-MM-DD, keep as-is; new format is DD/MM/YY.
  const date = ev.date ?? "";

  return {
    ...ev,
    date,
    preregFee,
    nonRegFee,
    playerCap: ev.playerCap ?? ev.cap ?? "",
    swissRounds: ev.swissRounds ?? ev.swiss ?? "",
    topCut: ev.topCut ?? ev.topcut ?? "",
    notes: ev.notes ?? ev.otherNotes ?? "",
    regStartTime: ev.regStartTime ?? ev.registrationStartTime ?? "",
    tournamentStartTime: ev.tournamentStartTime ?? ev.startTime ?? "",
    preregStartDate: ev.preregStartDate ?? ev.preRegStartDate ?? "",
    preregEndDate: ev.preregEndDate ?? ev.preRegEndDate ?? ev.preregCancelEndDate ?? "",
  };
}

/** ===== MAIN APP ===== */
export default function App() {
  // route: {name:'home'} | {name:'event', id}
  const [route, setRoute] = useState(() => {
    const m = window.location.hash.match(/^#\/event\/(.+)$/);
    return m ? { name: "event", id: m[1] } : { name: "home" };
  });

  const [admin, setAdmin] = useState(() => {
    const raw = localStorage.getItem(LS_KEYS.admin);
    const parsed = safeJsonParse(raw, { isAdmin: false });
    return !!parsed?.isAdmin;
  });

  const [events, setEvents] = useState(() => {
    // migrate older keys if present
    const raw =
      localStorage.getItem(LS_KEYS.events) ||
      localStorage.getItem("tm_events_v4") ||
      localStorage.getItem("tm_events_v3") ||
      localStorage.getItem("tm_events_v2") ||
      localStorage.getItem("tm_events_v1");
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed.map(normalizeLegacyEventFields) : [];
  });

  const [subscribers, setSubscribers] = useState(() => {
    const raw = localStorage.getItem(LS_KEYS.subscribers);
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  });

  const [newsletterEmail, setNewsletterEmail] = useState("");

  const [toast, setToast] = useState(null); // {type:'ok'|'err'|'info', text}

  // admin login fields (bottom)
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");

  // create/edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState("create"); // create | edit
  const [editingId, setEditingId] = useState(null);

  // registration form
  const [regFirst, setRegFirst] = useState("");
  const [regLast, setRegLast] = useState("");
  const [regNeuronId, setRegNeuronId] = useState("");
  const [regMsg, setRegMsg] = useState(null); // {type, text}

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
    localStorage.setItem(LS_KEYS.events, JSON.stringify(events));
  }, [events]);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.subscribers, JSON.stringify(subscribers));
  }, [subscribers]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [events]);

  const currentEvent = useMemo(() => {
    if (route.name !== "event") return null;
    return events.find((e) => e.id === route.id) || null;
  }, [route, events]);

  function goHome() {
    window.location.hash = "#/";
  }

  function openEvent(id) {
    window.location.hash = `#/event/${id}`;
  }

  function openCreate() {
    setModalMode("create");
    setEditingId(null);
    setModalOpen(true);
  }

  function openEdit(id) {
    setModalMode("edit");
    setEditingId(id);
    setModalOpen(true);
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

  function upsertEvent(next) {
    setEvents((prev) => {
      const idx = prev.findIndex((e) => e.id === next.id);
      if (idx === -1) return [next, ...prev];
      const copy = [...prev];
      copy[idx] = next;
      return copy;
    });
  }

  function createEvent(payload) {
    const now = Date.now();
    const ev = normalizeLegacyEventFields({
      id: uid("evt"),
      title: payload.title,
      date: payload.date, // DD/MM/YY
      location: payload.location,
      preregFee: payload.preregFee,
      nonRegFee: payload.nonRegFee,
      playerCap: payload.playerCap,
      swissRounds: payload.swissRounds,
      topCut: payload.topCut,
      regStartTime: payload.regStartTime,
      tournamentStartTime: payload.tournamentStartTime,
      preregStartDate: payload.preregStartDate,
      preregEndDate: payload.preregEndDate,
      description: payload.description || "",
      notes: payload.notes || "",
      imageDataUrl: payload.imageDataUrl,
      createdAt: now,
      updatedAt: now,
      registrations: [],
    });
    upsertEvent(ev);
    setToast({ type: "ok", text: "Događaj je objavljen." });

    // No-backend newsletter: prepare a mailto draft (admin can send via their email client)
    if (subscribers.length > 0) {
      const link = buildNewsletterMailto(ev, subscribers);
      if (link) {
        setToast({ type: "info", text: "Newsletter: klikni 'Send' u admin dijelu za slanje e-mail obavijesti." });
      }
    }
  }

  function updateEvent(id, patch) {
    setEvents((prev) =>
      prev.map((e) =>
        e.id === id
          ? normalizeLegacyEventFields({
              ...e,
              ...patch,
              updatedAt: Date.now(),
            })
          : e
      )
    );
    setToast({ type: "ok", text: "Objava je ažurirana." });
  }

  function deleteEvent(id) {
    setEvents((prev) => prev.filter((e) => e.id !== id));
    // If currently viewing this event, go home
    if (route.name === "event" && route.id === id) {
      window.location.hash = "#/";
    }
    setToast({ type: "info", text: "Događaj je obrisan." });
  }

  function addRegistration(eventId, reg) {
    setEvents((prev) =>
      prev.map((e) => {
        if (e.id !== eventId) return e;
        const ne = normalizeLegacyEventFields(e);
        const regs = Array.isArray(ne.registrations) ? ne.registrations : [];

        const cap = asIntOrNaN(ne.playerCap);
        if (Number.isFinite(cap) && cap > 0 && regs.length >= cap) return ne;

        const nid = normalizeNeuronId(reg.neuronId);
        // prevent duplicates by neuron id
        if (regs.some((x) => normalizeNeuronId(x.neuronId) === nid)) return ne;

        return {
          ...ne,
          registrations: [{ ...reg, neuronId: nid, id: uid("reg"), createdAt: Date.now() }, ...regs],
          updatedAt: Date.now(),
        };
      })
    );
  }

  function removeRegistrationByNeuronId(eventId, neuronId) {
    const nid = normalizeNeuronId(neuronId);
    let removed = false;

    setEvents((prev) =>
      prev.map((e) => {
        if (e.id !== eventId) return e;
        const ne = normalizeLegacyEventFields(e);
        const regs = Array.isArray(ne.registrations) ? ne.registrations : [];
        const nextRegs = regs.filter((r) => normalizeNeuronId(r.neuronId) !== nid);
        if (nextRegs.length !== regs.length) removed = true;
        return { ...ne, registrations: nextRegs, updatedAt: Date.now() };
      })
    );

    return removed;
  }

  function submitRegistration() {
    setRegMsg(null);
    if (!currentEvent) return;

    const ev = normalizeLegacyEventFields(currentEvent);
    const regs = Array.isArray(ev.registrations) ? ev.registrations : [];
    const cap = asIntOrNaN(ev.playerCap);

    if (Number.isFinite(cap) && cap > 0 && regs.length >= cap) {
      setRegMsg({ type: "err", text: "Prijave su zatvorene (popunjen maksimalan broj igrača)." });
      return;
    }

    const fn = regFirst.trim();
    const ln = regLast.trim();
    const nid = normalizeNeuronId(regNeuronId);

    if (!fn || !ln || !nid) {
      setRegMsg({ type: "err", text: "Ime, prezime i Neuron ID su obavezni." });
      return;
    }

    if (regs.some((x) => normalizeNeuronId(x.neuronId) === nid)) {
      setRegMsg({ type: "err", text: "Već si prijavljen s tim Neuron ID-em." });
      return;
    }

    addRegistration(ev.id, { firstName: fn, lastName: ln, neuronId: nid });
    setRegMsg({ type: "ok", text: "Uspješno si prijavljen." });
    setRegFirst("");
    setRegLast("");
    setRegNeuronId("");
  }

  function submitUnregister() {
    setRegMsg(null);
    if (!currentEvent) return;

    const ev = normalizeLegacyEventFields(currentEvent);
    const nid = normalizeNeuronId(regNeuronId);

    if (!nid) {
      setRegMsg({ type: "err", text: "Za odjavu je potreban Neuron ID." });
      return;
    }

    // We need removed result, but setState is async; do check synchronously on current list too.
    const regs = Array.isArray(ev.registrations) ? ev.registrations : [];
    const exists = regs.some((x) => normalizeNeuronId(x.neuronId) === nid);

    if (!exists) {
      setRegMsg({ type: "err", text: "Provjeri je li Neuron ID ispravan, nisi prijavljen." });
      return;
    }

    removeRegistrationByNeuronId(ev.id, nid);
    setRegMsg({ type: "ok", text: "Uspješno si odjavljen." });
    setRegNeuronId("");
  }

  function exportRegistrationsTxt(eventRaw) {
    const event = normalizeLegacyEventFields(eventRaw);
    const regs = Array.isArray(event?.registrations) ? event.registrations : [];
    const lines = regs
      .slice()
      .reverse()
      .map((r) => `${sanitizeText(r.firstName)}-${sanitizeText(r.lastName)}-${sanitizeText(r.neuronId)}`);

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
        <div className="page-subtitle">
          {route.name === "home" ? "Select a tournament to register or view details" : "Read details and register"}
        </div>
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

      {toast ? <div className={`toast toast--${toast.type}`}>{toast.text}</div> : null}

      {route.name === "home" ? (
        <>
          
          <section className="newsletter">
            <div className="newsletter__inner">
              <div className="newsletter__title">Newsletter</div>
              <div className="newsletter__subtitle">
                Upiši e-mail i spremi ga u sustav za obavijesti o novim eventima. (Bez backenda: e-mail se sprema u ovaj preglednik.)
              </div>

              <div className="newsletter__row">
                <input
                  className="input"
                  value={newsletterEmail}
                  onChange={(e) => setNewsletterEmail(e.target.value)}
                  placeholder="email@example.com"
                />
                <button
                  className="btn"
                  onClick={() => {
                    const e = (newsletterEmail || "").trim().toLowerCase();
                    if (!validateEmail(e)) {
                      setToast({ type: "err", text: "Unesi ispravnu e-mail adresu." });
                      return;
                    }
                    setSubscribers((prev) => {
                      if (prev.includes(e)) {
                        setToast({ type: "info", text: "Već si pretplaćen s tom e-mail adresom." });
                        return prev;
                      }
                      setToast({ type: "ok", text: "Pretplata uspješna." });
                      return [e, ...prev];
                    });
                    setNewsletterEmail("");
                  }}
                >
                  Subscribe
                </button>
              </div>

              {subscribers.length > 0 ? (
                <div className="newsletter__foot">
                  Spremljeno: <b>{subscribers.length}</b> e-mail adresa
                </div>
              ) : null}
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
                {sortedEvents.map((eRaw) => {
                  const e = normalizeLegacyEventFields(eRaw);
                  return (
                    <div key={e.id} className="event-card-wrap">
                      <button className="event-card" onClick={() => openEvent(e.id)}>
                        <div className="event-card__image">
                          {e.imageDataUrl ? <img src={e.imageDataUrl} alt={e.title} /> : <div className="img-placeholder" />}
                        </div>
                        <div className="event-card__meta">
                          <div className="event-card__title">{e.title}</div>
                          <div className="event-card__date">{formatDateLabel(e.date)}</div>
                        </div>
                      </button>

                      {admin ? (
                        <button className="btn btn--small" onClick={() => openEdit(e.id)}>
                          Edit
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Admin login + actions at bottom */}
          <section className="admin-section">
            <div className="admin-box">
              <h3>ADMIN ACCESS</h3>

              {!admin ? (
                <div className="admin-login">
                  <input
                    className="admin-input"
                    value={loginUser}
                    onChange={(e) => setLoginUser(e.target.value)}
                    placeholder="Username"
                    autoComplete="username"
                  />
                  <input
                    className="admin-input"
                    value={loginPass}
                    onChange={(e) => setLoginPass(e.target.value)}
                    placeholder="Password"
                    type="password"
                    autoComplete="current-password"
                  />
                  <button className="admin-button" onClick={handleAdminLogin}>
                    Enter
                  </button>
                </div>
              ) : (
                <div className="admin-logged">
                  <div className="admin-status">Admin je prijavljen ✅</div>
                  <div className="admin-actions-row">
                    <button className="admin-button" onClick={openCreate}>
                      + New event
                    </button>

                    <button
                      className="btn btn--small"
                      onClick={() => {
                        const content = subscribers.join("\n") + (subscribers.length ? "\n" : "");
                        downloadTxt("newsletter_subscribers.txt", content);
                      }}
                      disabled={subscribers.length === 0}
                    >
                      Export subscribers
                    </button>

                    <button
                      className="btn btn--small"
                      onClick={() => {
                        const latest = sortedEvents[0] ? normalizeLegacyEventFields(sortedEvents[0]) : null;
                        const link = buildNewsletterMailto(latest, subscribers);
                        if (!link) {
                          setToast({ type: "err", text: "Nema eventa ili nema subscriber-a." });
                          return;
                        }
                        window.location.href = link;
                      }}
                      disabled={subscribers.length === 0 || sortedEvents.length === 0}
                    >
                      Send newsletter
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <EventModal
            open={modalOpen}
            mode={modalMode}
            initialEvent={modalMode === "edit" ? normalizeLegacyEventFields(events.find((e) => e.id === editingId) || null) : null}
            onClose={() => setModalOpen(false)}
            onCreate={(payload) => {
              createEvent(payload);
              setModalOpen(false);
            }}
            onUpdate={(payload) => {
              if (!editingId) return;
              updateEvent(editingId, payload);
              setModalOpen(false);
            }}
            onDelete={(id) => {
              if (!id) return;
              deleteEvent(id);
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
              const ev = normalizeLegacyEventFields(currentEvent);
              const regs = Array.isArray(ev.registrations) ? ev.registrations : [];
              const cap = asIntOrNaN(ev.playerCap);
              const capText = Number.isFinite(cap) && cap > 0 ? `${regs.length}/${cap}` : `${regs.length}/∞`;
              const capReached = Number.isFinite(cap) && cap > 0 && regs.length >= cap;

              return (
                <div className="detail-grid">
                  <div className="detail-card">
                    <div className="detail-hero">
                      {ev.imageDataUrl ? <img src={ev.imageDataUrl} alt={ev.title} /> : <div className="img-placeholder hero-placeholder" />}
                    </div>

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
                          <button className="btn btn--ghost" onClick={() => openEdit(ev.id)}>
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
                          <button className="btn" onClick={submitRegistration} disabled={capReached}>
                            {capReached ? "Player cap reached" : "Register"}
                          </button>
                          <button className="btn btn--ghost" onClick={submitUnregister}>
                            Unregister
                          </button>
                        </div>

                        {capReached ? (
                          <div className="inline-alert inline-alert--err">Registrations are closed (player cap reached).</div>
                        ) : null}

                        {regMsg ? <div className={`inline-alert inline-alert--${regMsg.type}`}>{regMsg.text}</div> : null}
                      </div>
                    </div>

                    {admin ? (
                      <div className="panel">
                        <div className="panel-head">
                          <div>
                            <div className="panel-title">Registrations</div>
                            <div className="panel-subtitle">
                              Admin only • Total: <b>{regs.length}</b>
                            </div>
                          </div>
                          <button className="btn btn--small" onClick={() => exportRegistrationsTxt(ev)} disabled={regs.length === 0}>
                            Export .txt
                          </button>
                        </div>

                        {regs.length === 0 ? (
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
                                {regs.map((r) => (
                                  <tr key={r.id}>
                                    <td>{r.firstName}</td>
                                    <td>{r.lastName}</td>
                                    <td>{r.neuronId}</td>
                                    <td className="muted">{new Date(r.createdAt).toLocaleString("hr-HR")}</td>
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
            initialEvent={modalMode === "edit" ? normalizeLegacyEventFields(events.find((e) => e.id === editingId) || null) : null}
            onClose={() => setModalOpen(false)}
            onCreate={(payload) => {
              createEvent(payload);
              setModalOpen(false);
            }}
            onUpdate={(payload) => {
              if (!editingId) return;
              updateEvent(editingId, payload);
              setModalOpen(false);
            }}
            onDelete={(id) => {
              if (!id) return;
              deleteEvent(id);
              setModalOpen(false);
            }}
          />
        </section>
      )}
    </div>
  );
}

/** ===== EVENT MODAL (CREATE / EDIT) ===== */
function EventModal({ open, mode, initialEvent, onClose, onCreate, onUpdate, onDelete }) {
  const isEdit = mode === "edit";

  const [eventId, setEventId] = useState(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(""); // DD/MM/YY
  const [location, setLocation] = useState("");
  const [preregFee, setPreregFee] = useState("");
  const [nonRegFee, setNonRegFee] = useState("");
  const [playerCap, setPlayerCap] = useState("");
  const [swissRounds, setSwissRounds] = useState("");
  const [topCut, setTopCut] = useState("");
  const [regStartTime, setRegStartTime] = useState(""); // HH:MM
  const [tournamentStartTime, setTournamentStartTime] = useState(""); // HH:MM
  const [preregStartDate, setPreregStartDate] = useState(""); // DD/MM/YY
  const [preregEndDate, setPreregEndDate] = useState(""); // DD/MM/YY
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

    const pFee =
      initialEvent?.preregFee ?? initialEvent?.preRegistrationFee ?? initialEvent?.preRegFee ?? initialEvent?.fee ?? initialEvent?.price ?? "";
    const nFee =
      initialEvent?.nonRegFee ?? initialEvent?.nonRegisteredFee ?? initialEvent?.nonRegisteredPlayersFee ?? (pFee !== "" ? pFee : "");

    setPreregFee(pFee === 0 || pFee ? String(pFee) : "");
    setNonRegFee(nFee === 0 || nFee ? String(nFee) : "");
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
    const dt = sanitizeText(date);
    const loc = location.trim();
    const desc = description.trim();
    const nts = notes.trim();

    if (!imageDataUrl) return setErr("Slika je obavezna.");
    if (!t) return setErr("Naziv događaja je obavezan.");
    if (!dt) return setErr("Datum događaja je obavezan.");
    const dtNorm = normalizeDateInput(dt);
    if (!dtNorm) return setErr("Datum nije ispravan. Primjeri: 01/03/26, 01.03.2026., 1/3/26");
    if (!loc) return setErr("Mjesto događaja je obavezno.");

    if (preregFee === "" || preregFee === null || preregFee === undefined) return setErr("PreRegistration Fee je obavezan.");
    if (nonRegFee === "" || nonRegFee === null || nonRegFee === undefined) return setErr("Non registered players Fee je obavezan.");
    if (playerCap === "" || playerCap === null || playerCap === undefined) return setErr("Player Cap je obavezan.");
    if (swissRounds === "" || swissRounds === null || swissRounds === undefined) return setErr("Swiss rounds je obavezan.");
    if (topCut === "" || topCut === null || topCut === undefined) return setErr("TopCut je obavezan.");

    if (!regStartTime) return setErr("Vrijeme Početak prijava je obavezno.");
    if (!isValidTimeHHMM(regStartTime)) return setErr("Vrijeme Početak prijava mora biti HH:MM (npr. 09:30).");

    if (!tournamentStartTime) return setErr("Vrijeme Početak turnira je obavezno.");
    if (!isValidTimeHHMM(tournamentStartTime)) return setErr("Vrijeme Početak turnira mora biti HH:MM (npr. 10:00).");

    if (!preregStartDate) return setErr("Datum Početak pretprijava je obavezan.");
    const preStartNorm = normalizeDateInput(preregStartDate);
    if (!preStartNorm) return setErr("Datum Početak pretprijava nije ispravan (npr. 01/03/26).");

    if (!preregEndDate) return setErr("Datum Završetak pretprijava/odjava je obavezan.");
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
      description: desc,
      notes: nts,
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
              <div className="label">* Event date (DD/MM/YY)</div>
              <input className="input" value={date} onChange={(e) => setDate(e.target.value)} onBlur={() => { const n = normalizeDateInput(date); if (n) setDate(n); }} placeholder="10/02/26" />
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
              <div className="label">* Datum Početak pretprijava (DD/MM/YY)</div>
              <input className="input" value={preregStartDate} onChange={(e) => setPreregStartDate(e.target.value)} onBlur={() => { const n = normalizeDateInput(preregStartDate); if (n) setPreregStartDate(n); }} placeholder="01/02/26" />
            </div>

            <div className="form-row">
              <div className="label">* Datum Završetak pretprijava/odjava (DD/MM/YY)</div>
              <input className="input" value={preregEndDate} onChange={(e) => setPreregEndDate(e.target.value)} onBlur={() => { const n = normalizeDateInput(preregEndDate); if (n) setPreregEndDate(n); }} placeholder="09/02/26" />
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
              <button
                className="btn btn--ghost btn--danger"
                onClick={() => {
                  const ok = window.confirm("Obrisati ovaj događaj? Ova radnja je nepovratna.");
                  if (!ok) return;
                  onDelete?.(eventId);
                }}
              >
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
