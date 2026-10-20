// ============================================================
// AgendaPro — script.js (Supabase edition + Multi-user auth)
// ============================================================

const $ = (selector) => document.querySelector(selector);

// ── Usuário autenticado atual ───────────────────────────────
let currentUser = null;

// ── Helpers de formatação ───────────────────────────────────
function formatDate(date) {
  if (!date) return "—";
  const parts = date.split("-");
  if (parts.length !== 3) return "—";
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function todayString() {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
}

// Normaliza status caso algum registro antigo tenha sido salvo com encoding corrompido
function normalizeStatus(status) {
  if (!status) return "Agendado";
  if (status === "Conclu?do" || status === "Concluído") return "Concluído";
  return status;
}

// Evita que nomes e observações sejam interpretados como HTML.
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function emptyState(title, description) {
  return `
    <div class="empty-state">
      <strong>${escapeHTML(title)}</strong>
      <span>${escapeHTML(description)}</span>
    </div>
  `;
}

// ── Estado global (cache em memória) ────────────────────────
let clients = [];
let appointments = [];
let services = [];

// ── Estado do portal do cliente ─────────────────────────────
let clientProfile      = null;
let clientServices     = [];
let clientAppointments = [];

// ── Mapeamento DB (snake_case) <-> JS (camelCase) ───────────
// O PostgreSQL retorna time como "HH:MM:SS", por isso usamos slice(0,5).
function dbToAppointment(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    service: row.service,
    date: row.date,
    time: row.time ? String(row.time).slice(0, 5) : row.time,
    price: row.price,
    notes: row.notes,
    status: normalizeStatus(row.status),
    createdAt: row.created_at
  };
}

function appointmentToDb(item) {
  return {
    id: item.id,
    client_id: item.clientId,
    service: item.service,
    date: item.date,
    time: item.time,
    price: item.price,
    notes: item.notes,
    status: normalizeStatus(item.status),
    user_id: currentUser ? currentUser.id : null
  };
}

// ── Carregamento inicial ────────────────────────────────────
async function loadAll() {
  if (!currentUser) return;

  try {
    const [
      { data: clientsData,      error: e1 },
      { data: servicesData,     error: e2 },
      { data: appointmentsData, error: e3 }
    ] = await Promise.all([
      db.from("clients").select("*").eq("user_id", currentUser.id).order("name"),
      db.from("services").select("*").eq("user_id", currentUser.id).order("name"),
      db.from("appointments").select("*").eq("user_id", currentUser.id).order("date").order("time")
    ]);

    if (e1 || e2 || e3) {
      const err = e1 || e2 || e3;
      alert("Erro ao carregar dados: " + err.message);
      return;
    }

    clients      = clientsData      || [];
    services     = servicesData     || [];
    appointments = (appointmentsData || []).map(dbToAppointment);
  } catch (err) {
    alert("Falha na conexão com o banco de dados: " + err.message);
    return;
  }

  renderAll();
}

// ── Helpers ─────────────────────────────────────────────────
function clientName(id) {
  const client = clients.find((item) => item.id === id);
  return client ? client.name : "Cliente removido";
}

function sortAppointments(items) {
  return [...items].sort((a, b) =>
    `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`)
  );
}

function getServiceDuration(serviceNameOrId, serviceList = services) {
  const found = serviceList.find(
    (s) => s.id === serviceNameOrId || s.name === serviceNameOrId
  );
  return Number(found?.duration) || 30;
}

function hasAppointmentConflict(
  date,
  time,
  duration,
  appointmentList = appointments,
  serviceList = services,
  ignoredId = null
) {
  const [hours, minutes] = time.split(":").map(Number);
  const start = hours * 60 + minutes;
  const end   = start + (Number(duration) || 30);

  return appointmentList.some((appointment) => {
    if (appointment.date !== date || appointment.id === ignoredId) return false;
    if (normalizeStatus(appointment.status) === "Cancelado") return false;

    const [existingHours, existingMinutes] = String(appointment.time || "00:00")
      .split(":")
      .map(Number);
    const existingStart = existingHours * 60 + existingMinutes;
    const existingDuration =
      Number(appointment.duration) ||
      getServiceDuration(appointment.service, serviceList);
    const existingEnd = existingStart + existingDuration;

    return start < existingEnd && existingStart < end;
  });
}

// ── Navegação entre as telas ────────────────────────────────
function openView(viewName) {
  const titles = {
    dashboard:    "Visão geral",
    agenda:       "Agenda",
    appointments: "Agendamentos",
    clients:      "Clientes",
    services:     "Serviços"
  };

  if (!titles[viewName]) return;

  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === viewName);
  });

  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });

  $("#page-title").textContent = titles[viewName];

  if (viewName === "agenda") {
    renderCalendar();
  }

  if (viewName === "appointments") {
    renderAppointments();
    renderClientOptions();
    renderServiceOptions();
  }

  if (viewName === "clients")   renderClients();
  if (viewName === "dashboard") renderDashboard();
  if (viewName === "services")  renderServices();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── AUTENTICAÇÃO ────────────────────────────────────────────

// Mostra ou esconde tela de auth vs app principal
function showApp(user) {
  currentUser = user;
  $("#auth-screen").style.display = "none";
  $("#main-app").style.display    = "block";
  const cp = $("#client-portal");
  if (cp) cp.style.display = "none";

  // Exibe e-mail do usuário no sidebar
  const email = user.email || "";
  const initials = email.slice(0, 2).toUpperCase();
  const userAvatar = $("#user-avatar");
  const userDisplay = $("#user-display");
  const userEmailDisplay = $("#user-email-display");
  if (userAvatar)       userAvatar.textContent = initials;
  if (userDisplay)      userDisplay.textContent = email.split("@")[0];
  if (userEmailDisplay) userEmailDisplay.textContent = email;

  loadAll();
}

function showAuth() {
  currentUser = null;
  clientProfile = null;
  $("#auth-screen").style.display = "flex";
  $("#main-app").style.display    = "none";
  const cp = $("#client-portal");
  if (cp) cp.style.display = "none";
}

// ── Verifica role e direciona para o portal correto ─────────
async function checkRoleAndShow(user) {
  const { data: profile, error } = await db
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!error && profile) {
    if (profile.role === "client") {
      showClientPortal(user, profile);
    } else {
      showApp(user);
    }
    return;
  }

  // Fallback seguro: verifica se o usuário veio de um convite via user_metadata
  const metaOwnerId  = user.user_metadata?.owner_id;
  const metaClientId = user.user_metadata?.client_record_id || null;

  if (metaOwnerId) {
    showClientPortal(user, {
      id: user.id,
      role: "client",
      owner_id: metaOwnerId,
      client_record_id: metaClientId
    });
    return;
  }

  showApp(user);
}

// ════════════════════════════════════════════════════════════
// PORTAL DO CLIENTE
// ════════════════════════════════════════════════════════════

function showClientPortal(user, profile) {
  clientProfile = profile;
  currentUser   = user;

  $("#auth-screen").style.display   = "none";
  $("#main-app").style.display      = "none";
  $("#client-portal").style.display = "block";

  const email = user.email || "";
  const greeting = $("#client-greeting");
  if (greeting) greeting.textContent = "Olá, " + email.split("@")[0];

  $("#client-date").min = todayString();

  loadClientData();
}

async function loadClientData() {
  if (!clientProfile?.owner_id) return;

  try {
    const [
      { data: servicesData, error: e1 },
      { data: apptData,     error: e2 }
    ] = await Promise.all([
      db.from("services")
        .select("*")
        .eq("user_id", clientProfile.owner_id)
        .order("name"),
      db.from("appointments")
        .select("*")
        .eq("user_id", clientProfile.owner_id)
        .order("date").order("time")
    ]);

    if (e1 || e2) {
      alert("Erro ao carregar dados: " + (e1 || e2).message);
      return;
    }

    clientServices     = servicesData || [];
    clientAppointments = (apptData || []).map(dbToAppointment);
  } catch (err) {
    alert("Falha na conexão: " + err.message);
    return;
  }

  renderClientServiceOptions();
  renderClientAppointments();
}

function renderClientServiceOptions() {
  const select = $("#client-service");
  if (!select) return;

  const prev = select.value;
  select.innerHTML = `
    <option value="">Selecione um serviço</option>
    ${clientServices.map((s) => `
      <option value="${escapeHTML(s.id)}">
        ${escapeHTML(s.name)} — ${formatCurrency(Number(s.price))}
      </option>
    `).join("")}
  `;

  if (clientServices.some((s) => s.id === prev)) select.value = prev;
  updateClientSelectedService();
}

function updateClientSelectedService() {
  const select       = $("#client-service");
  const durationNote = $("#client-service-duration");
  if (!select || !durationNote) return;

  const service = clientServices.find((s) => s.id === select.value);
  if (service) {
    durationNote.textContent = `Duração prevista: ${service.duration} minutos.`;
  } else {
    durationNote.textContent = clientServices.length
      ? "Selecione um serviço."
      : "Nenhum serviço disponível.";
  }
}

function renderClientAppointments() {
  const container = $("#client-appointments-list");
  if (!container) return;

  const sorted = sortAppointments(clientAppointments);

  if (!sorted.length) {
    container.innerHTML = emptyState(
      "Nenhum agendamento ainda",
      "Seja o primeiro a agendar usando o formulário acima!"
    );
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Data e horário</th>
          <th>Serviço</th>
          <th>Valor</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map((item) => {
          const s   = normalizeStatus(item.status);
          const cls = s === "Concluído" ? "badge-concluido"
                    : s === "Cancelado" ? "badge-cancelado"
                    : "badge-agendado";
          return `
            <tr>
              <td>
                <strong>${formatDate(item.date)}</strong>
                <div>${escapeHTML(item.time)}</div>
              </td>
              <td>${escapeHTML(item.service)}</td>
              <td>${formatCurrency(item.price)}</td>
              <td><span class="badge ${cls}">${escapeHTML(s)}</span></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// ── Formulário de agendamento (cliente) ─────────────────────
document.addEventListener("DOMContentLoaded", () => {
  $("#client-service")?.addEventListener("change", updateClientSelectedService);

  $("#client-appointment-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const serviceId = $("#client-service").value;
    const date      = $("#client-date").value;
    const time      = $("#client-time").value;
    const notes     = $("#client-notes").value.trim();

    if (!serviceId || !date || !time) {
      alert("Selecione o serviço, data e horário.");
      return;
    }

    if (date < todayString()) {
      alert("Não é possível agendar para uma data passada.");
      return;
    }

    const selectedService = clientServices.find((s) => s.id === serviceId);
    const serviceName     = selectedService ? selectedService.name : serviceId;
    const price           = selectedService ? Number(selectedService.price) : 0;
    const duration        = selectedService ? Number(selectedService.duration) : 30;

    const conflict = hasAppointmentConflict(
      date,
      time,
      duration,
      clientAppointments,
      clientServices
    );
    if (conflict) {
      alert("Este horário já está ocupado. Escolha outro.");
      return;
    }

    const newAppt = {
      id:        makeId(),
      clientId:  clientProfile.client_record_id || null,
      service:   serviceName,
      date,
      time,
      price,
      notes,
      status:    "Agendado",
      createdAt: new Date().toISOString()
    };

    const btn = event.target.querySelector("[type=submit]");
    btn.disabled = true;

    try {
      const dbRecord = {
        id:        newAppt.id,
        client_id: newAppt.clientId,
        service:   newAppt.service,
        date:      newAppt.date,
        time:      newAppt.time,
        price:     newAppt.price,
        notes:     newAppt.notes,
        status:    newAppt.status,
        user_id:   clientProfile.owner_id   // Deve ser o user_id do DONO
      };

      const { error } = await db.from("appointments").insert(dbRecord);
      if (error) { alert("Erro ao agendar: " + error.message); return; }

      clientAppointments.push(newAppt);
      event.target.reset();
      $("#client-date").min = todayString();
      updateClientSelectedService();
      renderClientAppointments();
      alert("Agendamento criado com sucesso!");
    } finally {
      btn.disabled = false;
    }
  });
});


// ── Envio de convite por e-mail (via Supabase Edge Function) ─
async function sendEmailInvite(client, inviteLink) {
  const EDGE_URL = `${SUPABASE_URL}/functions/v1/send-invite`;

  const btn = document.querySelector(`[data-invite-email="${client.id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Enviando…"; }

  try {
    const { data: { session } } = await db.auth.getSession();
    const token = session?.access_token ?? SUPABASE_KEY;

    const res = await fetch(EDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_KEY,
      },
      body: JSON.stringify({
        clientEmail: client.email,
        clientName:  client.name,
        inviteLink,
        ownerEmail:  currentUser?.email ?? "",
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    // Também copia o link
    try { await navigator.clipboard.writeText(inviteLink); } catch { /* ignora */ }

    alert(`✅ Convite enviado para ${client.email}!\n\nO link também foi copiado para a área de transferência.`);
  } catch (err) {
    console.error("Erro ao enviar convite:", err);
    // Fallback: copia o link manualmente
    try {
      await navigator.clipboard.writeText(inviteLink);
      alert(`⚠️ Não foi possível enviar o e-mail (${err.message}).\n\nO link foi copiado — envie manualmente para ${client.email}.`);
    } catch {
      prompt("Copie o link e envie manualmente:", inviteLink);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "E-mail"; }
  }
}

// ── Link de convite ─────────────────────────────────────────
function generateInviteLink(clientId) {
  const payload = btoa(JSON.stringify({ o: currentUser.id, c: clientId }));
  return `${window.location.origin}${window.location.pathname}?invite=${payload}`;
}

// ── Processa invite da URL ──────────────────────────────────
function parseInviteFromURL() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get("invite");
  if (!invite) return;

  try {
    const { o: ownerId, c: clientId } = JSON.parse(atob(invite));
    if (!ownerId) return;

    // Ativa a aba de cadastro
    document.querySelector(".auth-tab[data-tab='signup']")?.click();

    // Exibe o aviso de convite
    const notice = $("#invite-notice");
    if (notice) notice.hidden = false;

    // Preenche os campos ocultos
    const ownerInput  = $("#invite-owner-id");
    const clientInput = $("#invite-client-id");
    if (ownerInput)  ownerInput.value  = ownerId;
    if (clientInput) clientInput.value = clientId || "";
  } catch {
    // Link inválido — ignora silenciosamente
  }
}

// Exibe mensagem de erro inline
function showAuthError(elementId, message) {
  const el = $(elementId);
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function clearAuthError(elementId) {
  const el = $(elementId);
  if (!el) return;
  el.textContent = "";
  el.hidden = true;
}

function showAuthSuccess(elementId, message) {
  const el = $(elementId);
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

// ── Tabs de login/cadastro ──────────────────────────────────
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;

    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".auth-form").forEach((f) => f.classList.remove("active"));

    tab.classList.add("active");
    $(`#${target}-form`)?.classList.add("active");

    // Limpa mensagens ao trocar de tab
    clearAuthError("#login-error");
    clearAuthError("#signup-error");
    clearAuthError("#signup-success");
    clearAuthError("#reset-success");
  });
});

// ── Login ───────────────────────────────────────────────────
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearAuthError("#login-error");
  clearAuthError("#reset-success");

  const email    = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const btn      = $("#login-btn");

  btn.disabled    = true;
  btn.textContent = "Entrando…";

  try {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
      showAuthError("#login-error", traduzirErroAuth(error.message));
    }
    // Se ok, onAuthStateChange cuida do resto
  } catch (err) {
    showAuthError("#login-error", "Erro inesperado. Tente novamente.");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Entrar";
  }
});

// ── Cadastro ────────────────────────────────────────────────
$("#signup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearAuthError("#signup-error");
  clearAuthError("#signup-success");

  const email    = $("#signup-email").value.trim();
  const password = $("#signup-password").value;
  const confirm  = $("#signup-confirm").value;
  const btn      = $("#signup-btn");

  if (password !== confirm) {
    showAuthError("#signup-error", "As senhas não coincidem.");
    return;
  }

  if (password.length < 6) {
    showAuthError("#signup-error", "A senha deve ter pelo menos 6 caracteres.");
    return;
  }

  btn.disabled    = true;
  btn.textContent = "Criando conta…";

  try {
    // Inclui dados do convite (se vier de link de convite)
    const ownerId  = $("#invite-owner-id")?.value  || null;
    const clientId = $("#invite-client-id")?.value || null;

    const signUpOptions = ownerId
      ? { options: { data: { owner_id: ownerId, client_record_id: clientId } } }
      : {};

    const { data, error } = await db.auth.signUp({ email, password, ...signUpOptions });
    if (error) {
      showAuthError("#signup-error", traduzirErroAuth(error.message));
    } else {
      // Verifica se o usuário já foi confirmado automaticamente (email confirmation off)
      if (data.session) {
        // Sessão criada imediatamente — onAuthStateChange cuida do resto
      } else {
        showAuthSuccess(
          "#signup-success",
          "Conta criada! Verifique seu e-mail para confirmar o cadastro antes de entrar."
        );
        $("#signup-form").reset();
      }
    }
  } catch (err) {
    showAuthError("#signup-error", "Erro inesperado. Tente novamente.");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Criar conta";
  }
});

// ── Esqueci a senha ─────────────────────────────────────────
$("#forgot-password-btn").addEventListener("click", async () => {
  clearAuthError("#login-error");
  clearAuthError("#reset-success");

  const email = $("#login-email").value.trim();
  if (!email) {
    showAuthError("#login-error", "Digite seu e-mail acima para recuperar a senha.");
    return;
  }

  const btn = $("#forgot-password-btn");
  btn.disabled    = true;
  btn.textContent = "Enviando…";

  try {
    const { error } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if (error) {
      showAuthError("#login-error", traduzirErroAuth(error.message));
    } else {
      showAuthSuccess(
        "#reset-success",
        `Link de redefinição enviado para ${email}. Verifique sua caixa de entrada.`
      );
    }
  } catch (err) {
    showAuthError("#login-error", "Erro ao enviar e-mail de recuperação.");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Esqueci minha senha";
  }
});

// ── Logout (com modal moderno de confirmação) ───────────────
function openLogoutModal() {
  const modal = $("#logout-modal");
  if (!modal) {
    db.auth.signOut();
    return;
  }
  const desc = $("#logout-modal-desc");
  if (desc && currentUser?.email) {
    desc.textContent = `Você está conectado como ${currentUser.email}. Deseja sair da sua conta?`;
  }
  modal.hidden = false;
}

function closeLogoutModal() {
  const modal = $("#logout-modal");
  if (modal) modal.hidden = true;
}

document.addEventListener("click", async (event) => {
  if (
    event.target.closest("#logout-btn") ||
    event.target.closest("#mobile-logout-btn") ||
    event.target.closest("#client-logout-btn")
  ) {
    openLogoutModal();
    return;
  }

  if (
    event.target.closest("#cancel-logout-btn") ||
    event.target === $("#logout-modal")
  ) {
    closeLogoutModal();
    return;
  }

  if (event.target.closest("#confirm-logout-btn")) {
    const btn = $("#confirm-logout-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saindo…";
    }
    try {
      await db.auth.signOut();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Sair da conta";
      }
      closeLogoutModal();
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#logout-modal")?.hidden) {
    closeLogoutModal();
  }
});

// ── Tradução de erros do Supabase Auth ──────────────────────
function traduzirErroAuth(msg) {
  const map = {
    "Invalid login credentials":         "E-mail ou senha incorretos.",
    "Email not confirmed":               "Confirme seu e-mail antes de entrar.",
    "User already registered":           "Este e-mail já está cadastrado.",
    "Password should be at least 6 characters": "A senha deve ter pelo menos 6 caracteres.",
    "Unable to validate email address: invalid format": "Formato de e-mail inválido.",
    "Email rate limit exceeded":         "Muitas tentativas. Aguarde alguns minutos.",
    "signup_disabled":                   "Cadastros estão desabilitados no momento."
  };
  return map[msg] || msg;
}

// ── Ouvinte de mudança de sessão (ponto central de controle) ─
db.auth.onAuthStateChange((event, session) => {
  if (session && session.user) {
    checkRoleAndShow(session.user);
  } else {
    showAuth();
  }
});

// ── Inicialização: verifica sessão existente ────────────────
(async () => {
  parseInviteFromURL();
  const { data: { session } } = await db.auth.getSession();
  if (session && session.user) {
    checkRoleAndShow(session.user);
  } else {
    showAuth();
  }
})();

// ── CLIENTES ────────────────────────────────────────────────
function resetClientForm() {
  $("#client-form").reset();
  $("#client-id").value = "";
  const emailInput = $("#client-email");
  if (emailInput) emailInput.value = "";
  $("#client-form-title").textContent = "Adicionar cliente";
  $("#save-client").textContent = "Salvar cliente";
  $("#cancel-client-edit").hidden = true;
}

$("#client-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const id    = $("#client-id").value;
  const name  = $("#client-name").value.trim();
  const phone = $("#client-phone").value.trim();
  const email = ($("#client-email")?.value || "").trim();
  const notes = $("#client-notes").value.trim();

  if (!name || !phone) {
    alert("Preencha o nome e o telefone do cliente.");
    return;
  }

  const duplicatePhone = clients.some((client) =>
    client.phone.replace(/\D/g, "") === phone.replace(/\D/g, "") &&
    client.id !== id
  );

  if (duplicatePhone) {
    alert("Já existe um cliente cadastrado com esse telefone.");
    return;
  }

  const btn = $("#save-client");
  btn.disabled = true;

  try {
    if (id) {
      const payload = { name, phone, email: email || null, notes };
      let { error } = await db.from("clients").update(payload).eq("id", id);

      // Fallback caso a coluna email ainda não exista no banco remoto
      if (error && error.message?.includes("email")) {
        ({ error } = await db.from("clients").update({ name, phone, notes }).eq("id", id));
      }

      if (error) { alert("Erro ao atualizar cliente: " + error.message); return; }

      const index = clients.findIndex((c) => c.id === id);
      if (index !== -1) clients[index] = { ...clients[index], name, phone, email: email || null, notes };
    } else {
      const newClient = {
        id: makeId(),
        name,
        phone,
        email: email || null,
        notes,
        user_id: currentUser.id
      };
      let { error } = await db.from("clients").insert(newClient);

      // Fallback caso a coluna email ainda não exista no banco remoto
      if (error && error.message?.includes("email")) {
        const { email: _ignored, ...fallbackClient } = newClient;
        ({ error } = await db.from("clients").insert(fallbackClient));
      }

      if (error) { alert("Erro ao cadastrar cliente: " + error.message); return; }

      clients.push(newClient);
    }
  } finally {
    btn.disabled = false;
  }

  resetClientForm();
  renderAll();
  alert(id ? "Cliente atualizado com sucesso!" : "Cliente cadastrado com sucesso!");
});

$("#cancel-client-edit").addEventListener("click", resetClientForm);

function renderClients() {
  const query = $("#client-search").value.trim().toLowerCase();

  const filtered = [...clients]
    .filter((client) =>
      `${client.name} ${client.phone} ${client.email || ""}`.toLowerCase().includes(query)
    )
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  if (!filtered.length) {
    $("#clients-list").innerHTML = emptyState(
      query ? "Nenhum resultado encontrado" : "Nenhum cliente cadastrado",
      query
        ? "Tente pesquisar por outro nome, telefone ou e-mail."
        : "Cadastre seu primeiro cliente usando o formulário acima."
    );
    return;
  }

  $("#clients-list").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Cliente</th>
          <th>Telefone</th>
          <th>Agendamentos</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map((client) => {
          const count = appointments.filter((item) => item.clientId === client.id).length;
          const subtitle = [
            client.email ? `✉️ ${client.email}` : null,
            client.notes || "Sem observações"
          ].filter(Boolean).join(" · ");

          return `
            <tr>
              <td class="person-cell">
                <strong>${escapeHTML(client.name)}</strong>
                <small>${escapeHTML(subtitle)}</small>
              </td>
              <td>${escapeHTML(client.phone)}</td>
              <td>${count}</td>
              <td>
                <div class="action-group">
                  <button class="action-button"
                    data-edit-client="${escapeHTML(client.id)}">Editar</button>
                  <button class="action-button"
                    data-invite-client="${escapeHTML(client.id)}" title="Enviar convite via WhatsApp">Convidar</button>
                  ${client.email ? `
                    <button class="action-button"
                      data-invite-email="${escapeHTML(client.id)}" title="Enviar convite por e-mail (${escapeHTML(client.email)})">E-mail</button>
                  ` : ""}
                  <button class="action-button delete"
                    data-delete-client="${escapeHTML(client.id)}">Excluir</button>
                </div>
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

$("#client-search").addEventListener("input", renderClients);

$("#clients-list").addEventListener("click", async (event) => {
  const editButton        = event.target.closest("[data-edit-client]");
  const deleteButton      = event.target.closest("[data-delete-client]");
  const inviteButton      = event.target.closest("[data-invite-client]");
  const inviteEmailButton = event.target.closest("[data-invite-email]");

  if (inviteButton) {
    const id     = inviteButton.dataset.inviteClient;
    const client = clients.find((item) => item.id === id);
    if (!client) return;

    const link = generateInviteLink(id);

    // Monta o número do WhatsApp (remove não-dígitos e adiciona DDI 55 se necessário)
    const digits  = client.phone.replace(/\D/g, "");
    const waPhone = digits.startsWith("55") ? digits : `55${digits}`;
    const waText  = encodeURIComponent(
      `Olá, ${client.name.split(" ")[0]}! 👋\n\nVocê foi convidado(a) para agendar online. Crie sua conta clicando no link abaixo:\n\n${link}`
    );
    window.open(`https://wa.me/${waPhone}?text=${waText}`, "_blank");
    return;
  }

  if (inviteEmailButton) {
    const id     = inviteEmailButton.dataset.inviteEmail;
    const client = clients.find((item) => item.id === id);
    if (!client || !client.email) return;

    const link = generateInviteLink(id);
    await sendEmailInvite(client, link);
    return;
  }

  if (editButton) {
    const client = clients.find((item) => item.id === editButton.dataset.editClient);
    if (!client) return;

    $("#client-id").value    = client.id;
    $("#client-name").value  = client.name;
    $("#client-phone").value = client.phone;
    if ($("#client-email")) $("#client-email").value = client.email || "";
    $("#client-notes").value = client.notes || "";
    $("#client-form-title").textContent = "Editar cliente";
    $("#save-client").textContent       = "Salvar alterações";
    $("#cancel-client-edit").hidden     = false;

    $("#client-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (deleteButton) {
    const id     = deleteButton.dataset.deleteClient;
    const client = clients.find((item) => item.id === id);
    if (!client) return;

    const linked  = appointments.filter((item) => item.clientId === id);
    const message = linked.length
      ? `Excluir ${client.name} também removerá ${linked.length} agendamento(s). Deseja continuar?`
      : `Deseja excluir o cliente ${client.name}?`;

    if (!confirm(message)) return;

    if (linked.length) {
      await db.from("appointments").delete().eq("client_id", id);
    }

    const { error } = await db.from("clients").delete().eq("id", id);
    if (error) { alert("Erro ao excluir cliente: " + error.message); return; }

    clients      = clients.filter((item) => item.id !== id);
    appointments = appointments.filter((item) => item.clientId !== id);

    if ($("#client-id").value === id) resetClientForm();
    renderAll();
  }
});

// ── AGENDAMENTOS ────────────────────────────────────────────
function renderClientOptions() {
  const select        = $("#appointment-client");
  const previousValue = select.value;

  select.innerHTML = `
    <option value="">Selecione um cliente</option>
    ${[...clients]
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((client) => `
        <option value="${escapeHTML(client.id)}">
          ${escapeHTML(client.name)} — ${escapeHTML(client.phone)}
        </option>
      `).join("")}
  `;

  if (clients.some((client) => client.id === previousValue)) {
    select.value = previousValue;
  }
}

$("#appointment-date").min = todayString();

$("#appointment-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const clientId  = $("#appointment-client").value;
  const serviceId = $("#appointment-service").value;
  const date      = $("#appointment-date").value;
  const time      = $("#appointment-time").value;
  const priceText = $("#appointment-price").value;
  const notes     = $("#appointment-notes").value.trim();

  if (!clients.some((client) => client.id === clientId)) {
    alert("Cadastre ou selecione um cliente válido antes de agendar.");
    return;
  }

  if (!serviceId || !date || !time) {
    alert("Preencha o serviço, a data e o horário.");
    return;
  }

  if (date < todayString()) {
    alert("Não é possível criar um agendamento para uma data passada.");
    return;
  }

  if (priceText !== "" && (!Number.isFinite(Number(priceText)) || Number(priceText) < 0)) {
    alert("Informe um valor válido para o serviço.");
    return;
  }

  // Usa o nome e duração do serviço selecionado
  const selectedService = services.find((s) => s.id === serviceId);
  const serviceName     = selectedService ? selectedService.name : serviceId;
  const duration        = selectedService ? Number(selectedService.duration) : 30;

  const conflict = hasAppointmentConflict(
    date,
    time,
    duration,
    appointments,
    services
  );
  if (conflict) {
    alert("Já existe um agendamento nesse dia e horário. Escolha outro horário.");
    return;
  }

  const newAppointment = {
    id:        makeId(),
    clientId,
    service:   serviceName,
    date,
    time,
    price:     priceText === "" ? 0 : Number(priceText),
    notes,
    status:    "Agendado",
    createdAt: new Date().toISOString()
  };

  const btn = event.target.querySelector("[type=submit]");
  btn.disabled = true;

  try {
    const { error } = await db.from("appointments").insert(appointmentToDb(newAppointment));
    if (error) { alert("Erro ao criar agendamento: " + error.message); return; }
    appointments.push(newAppointment);
  } finally {
    btn.disabled = false;
  }

  $("#appointment-form").reset();
  $("#appointment-date").min = todayString();
  updateSelectedService();
  renderAll();
  alert("Agendamento criado com sucesso!");
});

function renderAppointments() {
  const query = $("#appointment-search").value.trim().toLowerCase();

  const filtered = sortAppointments(appointments).filter((item) => {
    const searchable = `${clientName(item.clientId)} ${item.service} ${item.date} ${item.time}`.toLowerCase();
    return searchable.includes(query);
  });

  if (!filtered.length) {
    $("#appointments-list").innerHTML = emptyState(
      query ? "Nenhum resultado encontrado" : "Nenhum agendamento cadastrado",
      query
        ? "Tente pesquisar por outro cliente ou serviço."
        : "Use o formulário acima para marcar seu primeiro horário."
    );
    return;
  }

  $("#appointments-list").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Data e horário</th>
          <th>Cliente</th>
          <th>Serviço</th>
          <th>Valor</th>
          <th>Status</th>
          <th>Ação</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map((item) => {
          const s   = normalizeStatus(item.status);
          const cls = s === "Concluído" ? "badge-concluido"
                    : s === "Cancelado" ? "badge-cancelado"
                    : "badge-agendado";
          return `
            <tr>
              <td>
                <strong>${formatDate(item.date)}</strong>
                <div>${escapeHTML(item.time)}</div>
              </td>
              <td class="person-cell">
                <strong>${escapeHTML(clientName(item.clientId))}</strong>
                <small>${escapeHTML(item.notes || "Sem observações")}</small>
              </td>
              <td>${escapeHTML(item.service)}</td>
              <td>${formatCurrency(item.price)}</td>
              <td><span class="badge ${cls}">${escapeHTML(s)}</span></td>
              <td>
                <div class="action-group">
                  <select class="status-select" data-status-appointment="${escapeHTML(item.id)}">
                    <option value="Agendado"${s === "Agendado"  ? " selected" : ""}>Agendado</option>
                    <option value="Concluído"${s === "Concluído" ? " selected" : ""}>Concluído</option>
                    <option value="Cancelado"${s === "Cancelado" ? " selected" : ""}>Cancelado</option>
                  </select>
                  <button class="action-button delete"
                    data-delete-appointment="${escapeHTML(item.id)}">Excluir</button>
                </div>
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

$("#appointment-search").addEventListener("input", renderAppointments);

$("#appointments-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-appointment]");
  if (!button) return;

  const id          = button.dataset.deleteAppointment;
  const appointment = appointments.find((item) => item.id === id);
  if (!appointment) return;

  if (!confirm(
    `Deseja cancelar o agendamento de ${clientName(appointment.clientId)} em ${formatDate(appointment.date)} às ${appointment.time}?`
  )) return;

  const { error } = await db.from("appointments").delete().eq("id", id);
  if (error) { alert("Erro ao excluir agendamento: " + error.message); return; }

  appointments = appointments.filter((item) => item.id !== id);
  renderAll();
});

// Alteração de status do agendamento
$("#appointments-list").addEventListener("change", async (event) => {
  const select = event.target.closest("[data-status-appointment]");
  if (!select) return;

  const id        = select.dataset.statusAppointment;
  const newStatus = select.value;
  const index     = appointments.findIndex((item) => item.id === id);
  if (index === -1) return;

  const { error } = await db
    .from("appointments")
    .update({ status: newStatus })
    .eq("id", id);

  if (error) { alert("Erro ao atualizar status: " + error.message); return; }

  appointments[index].status = newStatus;
  renderAll();
});

// ── SERVIÇOS ────────────────────────────────────────────────
function renderServices() {
  const container = $("#services-list");
  if (!container) return;

  const search = ($("#service-search")?.value || "").trim().toLowerCase();
  const filtered = services.filter((service) =>
    service.name.toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    container.innerHTML = `
      <p class="empty-state">
        Nenhum serviço encontrado. Cadastre seu primeiro serviço acima.
      </p>
    `;
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Serviço</th>
          <th>Preço</th>
          <th>Duração</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map((service) => `
          <tr>
            <td>${escapeHTML(service.name)}</td>
            <td>${formatCurrency(Number(service.price))}</td>
            <td>${Number(service.duration)} min</td>
            <td>
              <div class="action-group">
                <button type="button" class="action-button"
                  data-edit-service="${service.id}">Editar</button>
                <button type="button" class="action-button delete"
                  data-delete-service="${service.id}">Excluir</button>
              </div>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderServiceOptions() {
  const select = $("#appointment-service");
  if (!select) return;

  const previousValue = select.value;

  select.innerHTML = `
    <option value="">Selecione um serviço</option>
    ${services.map((service) => `
      <option value="${service.id}">
        ${escapeHTML(service.name)} — ${formatCurrency(Number(service.price))}
      </option>
    `).join("")}
  `;

  if (services.some((service) => service.id === previousValue)) {
    select.value = previousValue;
  }

  updateSelectedService();
}

function updateSelectedService() {
  const select       = $("#appointment-service");
  const priceInput   = $("#appointment-price");
  const durationNote = $("#selected-service-duration");

  if (!select) return;

  const service = services.find((item) => item.id === select.value);

  if (service) {
    if (priceInput)   priceInput.value = Number(service.price).toFixed(2);
    if (durationNote) durationNote.textContent = `Duração prevista: ${service.duration} minutos.`;
  } else if (durationNote) {
    durationNote.textContent = services.length
      ? "Selecione um serviço."
      : "Cadastre um serviço para começar.";
  }
}

function resetServiceForm() {
  $("#service-form").reset();
  $("#service-id").value = "";
  $("#service-form-title").textContent = "Adicionar serviço";
  $("#service-submit").textContent     = "Salvar serviço";
  $("#service-cancel-edit").hidden     = true;
}

function editService(id) {
  const service = services.find((item) => item.id === id);
  if (!service) return;

  $("#service-id").value       = service.id;
  $("#service-name").value     = service.name;
  $("#service-price").value    = Number(service.price);
  $("#service-duration").value = String(service.duration);

  $("#service-form-title").textContent = "Editar serviço";
  $("#service-submit").textContent     = "Salvar alterações";
  $("#service-cancel-edit").hidden     = false;

  $("#service-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteService(id) {
  const service = services.find((item) => item.id === id);
  if (!service) return;

  const confirmed = confirm(
    `Deseja excluir o serviço "${service.name}"? Os agendamentos antigos serão mantidos.`
  );
  if (!confirmed) return;

  const { error } = await db.from("services").delete().eq("id", id);
  if (error) { alert("Erro ao excluir serviço: " + error.message); return; }

  services = services.filter((item) => item.id !== id);
  renderServices();
  renderServiceOptions();
}

$("#service-form")?.addEventListener("submit", async function (event) {
  event.preventDefault();

  const id       = $("#service-id").value;
  const name     = $("#service-name").value.trim();
  const price    = Number($("#service-price").value);
  const duration = Number($("#service-duration").value);

  if (!name || !Number.isFinite(price) || price < 0 || !duration) {
    alert("Preencha o nome, o preço e a duração corretamente.");
    return;
  }

  const duplicate = services.some((service) =>
    service.name.toLowerCase() === name.toLowerCase() && service.id !== id
  );

  if (duplicate) {
    alert("Já existe um serviço cadastrado com esse nome.");
    return;
  }

  const btn = $("#service-submit");
  btn.disabled = true;

  try {
    if (id) {
      const { error } = await db
        .from("services")
        .update({ name, price, duration })
        .eq("id", id);

      if (error) { alert("Erro ao atualizar serviço: " + error.message); return; }

      services = services.map((s) =>
        s.id === id ? { ...s, name, price, duration } : s
      );
    } else {
      const newService = { id: crypto.randomUUID(), name, price, duration, user_id: currentUser.id };
      const { error } = await db.from("services").insert(newService);

      if (error) { alert("Erro ao cadastrar serviço: " + error.message); return; }

      services.push(newService);
    }
  } finally {
    btn.disabled = false;
  }

  resetServiceForm();
  renderServices();
  renderServiceOptions();
  alert(id ? "Serviço atualizado!" : "Serviço cadastrado!");
});

$("#service-cancel-edit")?.addEventListener("click", resetServiceForm);
$("#service-search")?.addEventListener("input", renderServices);

$("#services-list")?.addEventListener("click", function (event) {
  const editButton   = event.target.closest("[data-edit-service]");
  const deleteButton = event.target.closest("[data-delete-service]");

  if (editButton)   editService(editButton.dataset.editService);
  if (deleteButton) deleteService(deleteButton.dataset.deleteService);
});

$("#appointment-service")?.addEventListener("change", updateSelectedService);

// ── DASHBOARD ───────────────────────────────────────────────
function renderDashboard() {
  const today = todayString();

  $("#total-clients").textContent      = clients.length;
  $("#total-appointments").textContent = appointments.length;

  const todayItems = sortAppointments(
    appointments.filter((item) => item.date === today)
  );

  $("#today-appointments").textContent = todayItems.length;

  const revenueToday = appointments
    .filter((item) => item.date === today && normalizeStatus(item.status) === "Concluído")
    .reduce((sum, item) => sum + Number(item.price || 0), 0);

  const monthPrefix  = today.slice(0, 7);
  const revenueMonth = appointments
    .filter((item) => item.date.startsWith(monthPrefix) && normalizeStatus(item.status) === "Concluído")
    .reduce((sum, item) => sum + Number(item.price || 0), 0);

  const elToday = $("#revenue-today");
  const elMonth = $("#revenue-month");
  if (elToday) elToday.textContent = formatCurrency(revenueToday);
  if (elMonth) elMonth.textContent = formatCurrency(revenueMonth);

  const upcoming = sortAppointments(
    appointments.filter(
      (item) =>
        `${item.date}T${item.time}` >= `${today}T00:00` &&
        normalizeStatus(item.status) !== "Cancelado"
    )
  ).slice(0, 5);

  if (!upcoming.length) {
    $("#dashboard-list").innerHTML = emptyState(
      "Sua agenda está vazia",
      "Cadastre um cliente e crie seu primeiro agendamento."
    );
    return;
  }

  $("#dashboard-list").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Data e horário</th>
          <th>Cliente</th>
          <th>Serviço</th>
          <th>Valor</th>
        </tr>
      </thead>
      <tbody>
        ${upcoming.map((item) => `
          <tr>
            <td>
              <strong>${formatDate(item.date)}</strong>
              <div>${escapeHTML(item.time)}</div>
            </td>
            <td>${escapeHTML(clientName(item.clientId))}</td>
            <td>${escapeHTML(item.service)}</td>
            <td>${formatCurrency(item.price)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderAll() {
  renderDashboard();
  renderClients();
  renderClientOptions();
  renderAppointments();
  renderServices();
  renderServiceOptions();
  renderCalendar();
}

// ── AGENDA DIÁRIA E SEMANAL ─────────────────────────────────
let calendarMode = "day";
let calendarDate = todayString();

function dateFromString(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function dateToString(date) {
  const year  = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day   = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(value, amount) {
  const date = dateFromString(value);
  date.setDate(date.getDate() + amount);
  return dateToString(date);
}

function startOfWeek(value) {
  const date    = dateFromString(value);
  const weekday = date.getDay();
  const diff    = weekday === 0 ? -6 : 1 - weekday;
  date.setDate(date.getDate() + diff);
  return dateToString(date);
}

function calendarDateLabel(value, options = {}) {
  return dateFromString(value).toLocaleDateString("pt-BR", options);
}

function renderCalendar() {
  const grid = $("#calendar-grid");
  if (!grid) return;

  const days = [];

  if (calendarMode === "day") {
    days.push(calendarDate);
  } else {
    const monday = startOfWeek(calendarDate);
    for (let i = 0; i < 7; i++) days.push(shiftDate(monday, i));
  }

  $("#day-mode").classList.toggle("active", calendarMode === "day");
  $("#week-mode").classList.toggle("active", calendarMode === "week");

  grid.classList.toggle("week-view", calendarMode === "week");

  if (calendarMode === "day") {
    $("#calendar-title").textContent = calendarDateLabel(calendarDate, {
      weekday: "long", day: "2-digit", month: "long", year: "numeric"
    });
  } else {
    const first = days[0];
    const last  = days[6];
    $("#calendar-title").textContent = `${formatDate(first)} — ${formatDate(last)}`;
  }

  const startHour = 8;
  const endHour   = 20;

  grid.innerHTML = days.map((day) => {
    const dayAppointments = sortAppointments(
      appointments.filter((item) => item.date === day)
    );

    const slots = [];

    for (let hour = startHour; hour <= endHour; hour++) {
      for (const minute of [0, 30]) {
        if (hour === endHour && minute === 30) continue;

        const time =
          `${String(hour).padStart(2, "0")}:` +
          `${String(minute).padStart(2, "0")}`;

        const events = dayAppointments.filter((item) => item.time === time);

        slots.push(`
          <div class="calendar-slot">
            <span class="slot-time">${time}</span>
            <div class="slot-content">
              ${
                events.length
                  ? events.map((item) => {
                      const isCancelled = normalizeStatus(item.status) === "Cancelado";
                      return `
                        <button type="button"
                          class="calendar-event${isCancelled ? " cancelled" : ""}"
                          data-calendar-event="${escapeHTML(item.id)}"
                          title="Ver detalhes do agendamento">
                          <strong>${escapeHTML(clientName(item.clientId))}</strong>
                          <small>${escapeHTML(item.service)}</small>
                          <small>${formatCurrency(item.price)}</small>
                        </button>
                      `;
                    }).join("")
                  : `<span class="slot-empty">Disponível</span>`
              }
            </div>
          </div>
        `);
      }
    }

    return `
      <section class="calendar-day">
        <header class="calendar-day-header">
          <strong>${calendarDateLabel(day, { weekday: "short" })}</strong>
          <small>${formatDate(day)}</small>
        </header>
        <div class="calendar-slots">
          ${slots.join("")}
        </div>
      </section>
    `;
  }).join("");
}

$("#day-mode").addEventListener("click", () => { calendarMode = "day";  renderCalendar(); });
$("#week-mode").addEventListener("click", () => { calendarMode = "week"; renderCalendar(); });

$("#calendar-prev").addEventListener("click", () => {
  calendarDate = shiftDate(calendarDate, calendarMode === "day" ? -1 : -7);
  renderCalendar();
});

$("#calendar-next").addEventListener("click", () => {
  calendarDate = shiftDate(calendarDate, calendarMode === "day" ? 1 : 7);
  renderCalendar();
});

$("#calendar-today").addEventListener("click", () => {
  calendarDate = todayString();
  renderCalendar();
});

$("#calendar-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-calendar-event]");
  if (!button) return;

  const item = appointments.find(
    (appointment) => appointment.id === button.dataset.calendarEvent
  );

  if (!item) return;

  alert(
    `Cliente: ${clientName(item.clientId)}\n` +
    `Serviço: ${item.service}\n` +
    `Data: ${formatDate(item.date)}\n` +
    `Horário: ${item.time}\n` +
    `Status: ${normalizeStatus(item.status)}\n` +
    `Valor: ${formatCurrency(item.price)}\n` +
    `Observações: ${item.notes || "Nenhuma"}`
  );
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => openView(button.dataset.view));
});

document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => openView(button.dataset.go));
});

$("#quick-add").addEventListener("click", () => {
  openView("appointments");
  $("#appointment-client").focus();
});
