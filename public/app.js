(() => {
  const $ = (s) => document.querySelector(s);

  /* ---------------- AUTH ---------------- */
  const authEl = $("#auth");
  const appEl = $("#app");
  const authForm = $("#authForm");
  const authBtn = $("#authBtn");
  const authError = $("#authError");
  const tabs = document.querySelectorAll(".tab");
  let mode = "login";

  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      mode = t.dataset.tab;
      authBtn.textContent = mode === "login" ? "Login" : "Register";
      authError.textContent = "";
    })
  );

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.textContent = "";
    authBtn.disabled = true;
    try {
      const r = await fetch("/" + mode, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: $("#email").value, password: $("#password").value })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Gagal");
      bootApp(j.email);
    } catch (err) {
      authError.textContent = err.message;
    } finally {
      authBtn.disabled = false;
    }
  });

  // Auto-login check
  fetch("/me")
    .then((r) => (r.ok ? r.json() : null))
    .then((u) => u && bootApp(u.email));

  /* ---------------- APP ---------------- */
  let socket;
  let currentConv = null;
  let streamingEl = null;

  function bootApp(email) {
    authEl.classList.add("hidden");
    appEl.classList.remove("hidden");
    $("#userEmail").textContent = email;
    connectSocket();
    bindUi();
  }

  function bindUi() {
    $("#logoutBtn").addEventListener("click", async () => {
      await fetch("/logout", { method: "POST" });
      location.reload();
    });
    $("#newChatBtn").addEventListener("click", () => {
      currentConv = null;
      $("#convTitle").textContent = "New Chat";
      renderMessages([]);
      document.querySelectorAll(".conv-item").forEach((x) => x.classList.remove("active"));
      closeSidebar();
    });
    $("#openSidebar").addEventListener("click", () => appEl.classList.add("sidebar-open"));
    $("#closeSidebar").addEventListener("click", closeSidebar);
    $("#backdrop").addEventListener("click", closeSidebar);

    const input = $("#input");
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 160) + "px";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        $("#chatForm").requestSubmit();
      }
    });

    $("#chatForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      sendMessage(text);
      input.value = "";
      input.style.height = "auto";
    });
  }

  function closeSidebar() {
    appEl.classList.remove("sidebar-open");
  }

  function connectSocket() {
    socket = io({ withCredentials: true });

    socket.on("connect_error", (e) => console.error("socket err:", e.message));

    socket.on("conversation_list", (list) => {
      const c = $("#convList");
      c.innerHTML = "";
      list.forEach((conv) => {
        const div = document.createElement("div");
        div.className = "conv-item" + (currentConv === conv.id ? " active" : "");
        div.innerHTML = `<span class="t"></span><button class="del" title="Hapus">🗑</button>`;
        div.querySelector(".t").textContent = conv.title;
        div.addEventListener("click", (e) => {
          if (e.target.classList.contains("del")) return;
          loadConversation(conv.id);
        });
        div.querySelector(".del").addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm("Hapus percakapan ini?")) return;
          await fetch("/conversations/" + conv.id, { method: "DELETE" });
          if (currentConv === conv.id) {
            currentConv = null;
            renderMessages([]);
            $("#convTitle").textContent = "New Chat";
          }
          // refresh list
          socket.emit("create_conversation_noop"); // noop -> server resends
          // simpler: just reload list
          fetch("/conversations").then(r=>r.json()).then(rebuildList);
        });
        c.appendChild(div);
      });
    });

    socket.on("conversation_created", ({ id, title }) => {
      currentConv = id;
      if (title) $("#convTitle").textContent = title;
    });

    socket.on("conversation_loaded", ({ id, title, messages }) => {
      currentConv = id;
      $("#convTitle").textContent = title;
      renderMessages(messages);
      document.querySelectorAll(".conv-item").forEach((x, i) => {
        x.classList.remove("active");
      });
      // re-highlight by matching text — simpler: refresh list
    });

    socket.on("ai_typing", (v) => {
      $("#typing").classList.toggle("hidden", !v);
      scrollBottom();
    });

    socket.on("message_stream", ({ delta }) => {
      if (!streamingEl) {
        streamingEl = appendMessage("assistant", "");
      }
      streamingEl.querySelector(".body").textContent += delta;
      scrollBottom();
    });

    socket.on("message_done", ({ content }) => {
      if (streamingEl) {
        streamingEl.querySelector(".body").textContent = content;
        streamingEl = null;
      }
      scrollBottom();
    });
  }

  function rebuildList(list) {
    const c = $("#convList");
    c.innerHTML = "";
    list.forEach((conv) => {
      const div = document.createElement("div");
      div.className = "conv-item" + (currentConv === conv.id ? " active" : "");
      div.innerHTML = `<span class="t"></span><button class="del" title="Hapus">🗑</button>`;
      div.querySelector(".t").textContent = conv.title;
      div.addEventListener("click", (e) => {
        if (e.target.classList.contains("del")) return;
        loadConversation(conv.id);
      });
      div.querySelector(".del").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Hapus percakapan ini?")) return;
        await fetch("/conversations/" + conv.id, { method: "DELETE" });
        if (currentConv === conv.id) {
          currentConv = null;
          renderMessages([]);
          $("#convTitle").textContent = "New Chat";
        }
        fetch("/conversations").then(r=>r.json()).then(rebuildList);
      });
      c.appendChild(div);
    });
  }

  function loadConversation(id) {
    socket.emit("load_conversation", id);
    closeSidebar();
  }

  function sendMessage(text) {
    appendMessage("user", text);
    streamingEl = null;
    socket.emit("send_message", { conversationId: currentConv, text });
  }

  function renderMessages(list) {
    const m = $("#messages");
    m.innerHTML = "";
    if (!list.length) {
      m.innerHTML = `<div class="empty"><h2>Mulai percakapan</h2><p>Tanyakan apa pun ke AI.</p></div>`;
      return;
    }
    list.forEach((msg) => appendMessage(msg.role, msg.content));
    scrollBottom();
  }

  function appendMessage(role, content) {
    const m = $("#messages");
    // remove empty state
    const empty = m.querySelector(".empty");
    if (empty) empty.remove();

    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    wrap.innerHTML = `<div class="avatar"></div><div class="body"></div>`;
    wrap.querySelector(".avatar").textContent = role === "user" ? "U" : "AI";
    wrap.querySelector(".body").textContent = content;
    m.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  function scrollBottom() {
    const m = $("#messages");
    m.scrollTop = m.scrollHeight;
  }
})();
