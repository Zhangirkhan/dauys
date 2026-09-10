const CSS = `
:root{
  --bg:#0e1512;--ink:#e8f0ea;--muted:#8aa094;--line:#1e2c24;
  --panel:#141c18;--accent:#c6f000;--accent-ink:#0e1512;
  --danger:#ff6b5a;--ok:#7dffb3;--warn:#ffd166;
  --font:ui-sans-serif,system-ui,"Segoe UI",sans-serif;
  --mono:ui-monospace,"Cascadia Mono","Consolas",monospace;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font:15px/1.45 var(--font)}
body{background:
  radial-gradient(900px 500px at 10% -10%,#1a3324 0%,transparent 55%),
  radial-gradient(700px 420px at 110% 0%,#172820 0%,transparent 50%),
  var(--bg)}
.wrap{max-width:720px;margin:0 auto;padding:28px 20px 48px}
h1{font-size:1.55rem;letter-spacing:-.02em;margin:0 0 .35rem;font-weight:700}
.sub{color:var(--muted);margin:0 0 1.4rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 18px 16px;margin:0 0 14px}
label{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 6px}
input[type=text],input[type=password],input[type=url],textarea{
  width:100%;background:#0b110e;border:1px solid var(--line);color:var(--ink);
  border-radius:10px;padding:11px 12px;font:inherit;outline:none}
input:focus,textarea:focus{border-color:#3d5a45}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
button,.btn{
  appearance:none;border:0;border-radius:999px;padding:10px 16px;font:600 14px/1 var(--font);
  cursor:pointer;background:var(--accent);color:var(--accent-ink)}
button.secondary,.btn.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
button:disabled{opacity:.45;cursor:not-allowed}
.status{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:.92rem}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.dot.on{background:var(--ok)}.dot.wait{background:var(--warn)}.dot.err{background:var(--danger)}
.code{
  font:700 2.4rem/1.1 var(--mono);letter-spacing:.18em;text-align:center;
  padding:18px 8px;margin:8px 0;color:var(--accent)}
.countdown{text-align:center;color:var(--muted);font-family:var(--mono);font-size:.85rem}
.apps{list-style:none;margin:0;padding:0;max-height:280px;overflow:auto}
.apps li{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)}
.apps li:first-child{border-top:0}
.apps .name{font-weight:600}
.apps .meta{color:var(--muted);font-size:.82rem;word-break:break-word}
.toggle{margin-top:3px}
.steps{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.step{font-size:.75rem;color:var(--muted);padding:4px 10px;border:1px solid var(--line);border-radius:999px}
.step.active{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}
.step.done{color:var(--ok);border-color:#2a4a38}
.err{color:var(--danger);font-size:.9rem;margin-top:8px}
.ok{color:var(--ok)}
.folders{color:var(--muted);font-size:.88rem}
.mono{font-family:var(--mono);font-size:.85rem}
.hide{display:none!important}
#boot-err{display:none;margin:12px 0;padding:10px 12px;border-radius:10px;background:#2a1512;color:var(--danger);border:1px solid #5a2a24;font-size:.9rem;white-space:pre-wrap}
#boot-err.show{display:block}
`;

/** Helpers must run before page script. */
function shell(title: string, markup: string, pageScript: string) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http://127.0.0.1:* http://localhost:*; img-src data:; base-uri 'none'; form-action 'none'"/>
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${markup}
<div id="boot-err"></div>
</div>
<script>
(function(){
  var bootErr = document.getElementById("boot-err");
  function showBoot(msg){
    if(!bootErr) return;
    bootErr.textContent = msg;
    bootErr.className = "show";
  }
  window.onerror = function(msg, src, line){
    showBoot("Ошибка интерфейса: " + msg + (line ? (" @" + line) : ""));
  };
  window.addEventListener("unhandledrejection", function(ev){
    showBoot("Ошибка: " + (ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason)));
  });
  async function api(path, opts){
    opts = opts || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    var r = await fetch(path, Object.assign({}, opts, { headers: headers }));
    var j = await r.json().catch(function(){ return { ok:false, error:{ message:"Некорректный ответ" } }; });
    if(!r.ok || j.ok === false) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
    return j.data !== undefined ? j.data : j;
  }
  function $(s, el){ return (el || document).querySelector(s); }
  function $$(s, el){ return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  window.dauysApi = api;
  window.dauys$ = $;
  window.dauys$$ = $$;
${pageScript}
})();
</script>
</body>
</html>`;
}

const WIZARD_MARKUP = `<h1>Dauys</h1>
<p class="sub">Настройте агент один раз. После этого он работает в системном трее.</p>
<div class="steps" id="steps"></div>
<div class="card" id="panel"></div>`;

/** Page script uses var api/$/$$ from outer IIFE scope. */
const WIZARD_SCRIPT = `
  var api = window.dauysApi;
  var $ = window.dauys$;
  var $$ = window.dauys$$;
  var steps = ["Сервер","Привязка","Папки","Приложения","Проверка"];
  var step = 0;
  var pair = { code: "", expiresAt: 0 };
  var bootstrap = "";
  var timer = null;
  var panel = $("#panel");
  var stepsEl = $("#steps");

  function paintSteps(){
    stepsEl.innerHTML = steps.map(function(s, i){
      var cls = i === step ? "active" : (i < step ? "done" : "");
      return '<span class="step ' + cls + '">' + (i + 1) + ". " + s + "</span>";
    }).join("");
  }

  function showErr(el, e){
    var msg = e instanceof Error ? e.message : String(e);
    if (/bootstrap.*at least 1|String must contain at least 1/i.test(msg))
      msg = "Введите bootstrap-секрет с сервера. Поле нельзя оставлять пустым при первой привязке.";
    else if (/ZodError|invalid_type|\\[\\{/i.test(msg))
      msg = "Проверьте поля формы. При сохранённой привязке секрет можно не вводить.";
    el.textContent = msg;
  }

  function htmlStep0(hasToken){
    return '<label>Адрес сервера</label>' +
      '<input id="url" type="url" value="https://dauys.esl.kz"/>' +
      (hasToken
        ? '<p class="ok" id="tokenHint" style="margin:12px 0 0">Найдена сохранённая привязка. Bootstrap-секрет не нужен.</p>' +
          '<label style="margin-top:12px" class="hide" id="bootLab">Bootstrap-секрет</label>' +
          '<input id="boot" type="password" class="hide" autocomplete="off"/>'
        : '<label style="margin-top:12px" id="bootLab">Bootstrap-секрет</label>' +
          '<input id="boot" type="password" autocomplete="off" placeholder="секрет с сервера (обязателен при первой привязке)"/>') +
      '<div class="row">' +
      '<button type="button" id="test">Проверить соединение</button>' +
      '<span class="status" id="st"><span class="dot" id="dot"></span><span id="stt">Ожидание</span></span>' +
      '</div><div class="err hide" id="err"></div>';
  }

  function htmlStep1(savedBinding){
    return '<p class="status" id="pst"><span class="dot wait" id="pdot"></span><span id="ptxt">Подключение к серверу</span></p>' +
      (savedBinding
        ? '<p class="ok" id="savedNote">Используется сохранённая привязка.</p><div class="code hide" id="code"></div><div class="countdown hide" id="cd"></div>'
        : '<div class="code" id="code">········</div><div class="countdown" id="cd"></div>' +
          '<p class="sub" style="margin:12px 0 0">Откройте сайт Dauys на телефоне и введите код.</p>') +
      '<div class="row">' +
      '<button type="button" class="secondary" id="retry">' + (savedBinding ? "Новый код (перепривязка)" : "Новый код") + '</button>' +
      '<button type="button" id="next" disabled>Далее</button>' +
      '</div><div class="err hide" id="err"></div>';
  }

  function htmlStep2(){
    return '<p class="sub">Выберите папки, к которым агент может обращаться (Документы, проекты и т.д.).</p>' +
      '<div class="folders mono" id="folders">Загрузка…</div>' +
      '<div class="row">' +
      '<button type="button" id="add">Добавить папку</button>' +
      '<button type="button" id="next">Далее</button>' +
      '</div><div class="err hide" id="err"></div>';
  }

  function htmlStep3(){
    return '<p class="sub">Отметьте программы, которыми можно управлять голосом.</p>' +
      '<ul class="apps" id="list"><li>Поиск…</li></ul>' +
      '<div class="row">' +
      '<button type="button" class="secondary" id="rediscover">Найти снова</button>' +
      '<button type="button" id="next">Далее</button>' +
      '</div><div class="err hide" id="err"></div>';
  }

  function htmlStep4(){
    return '<p class="sub">Проверьте, что агент выполняет простую команду, затем завершите настройку.</p>' +
      '<div class="row">' +
      '<button type="button" class="secondary" id="test">Тест команды</button>' +
      '<button type="button" id="done">Готово</button>' +
      '</div>' +
      '<pre class="mono" id="out" style="white-space:pre-wrap;margin-top:12px;color:var(--muted)"></pre>' +
      '<div class="err hide" id="err"></div>';
  }

  async function render(){
    paintSteps();
    if(step === 0){
      var st0 = { hasToken: false, server: "https://dauys.esl.kz" };
      try { st0 = await api("/api/status"); } catch (e) { /* offline UI */ }
      panel.innerHTML = htmlStep0(!!st0.hasToken);
      if (st0.server) $("#url").value = st0.server;
      $("#test").onclick = async function(){
        var err = $("#err");
        err.classList.add("hide");
        $("#dot").className = "dot wait";
        $("#stt").textContent = "Подключение к серверу";
        var bootEl = $("#boot");
        var bootVal = bootEl && !bootEl.classList.contains("hide") ? bootEl.value : "";
        try{
          if (!st0.hasToken && !(bootVal && bootVal.trim())) {
            throw new Error("Введите bootstrap-секрет с сервера. Поле нельзя оставлять пустым при первой привязке.");
          }
          var result = await api("/api/setup/test-connection", {
            method: "POST",
            body: JSON.stringify({
              serverUrl: $("#url").value.trim(),
              bootstrap: bootVal || undefined
            })
          });
          $("#dot").className = "dot on";
          $("#stt").textContent = result.hasToken ? "Привязка найдена" : "Сервер доступен";
          sessionStorage.setItem("dauys_url", $("#url").value.trim());
          bootstrap = bootVal;
          sessionStorage.setItem("dauys_has_token", result.hasToken ? "1" : "0");
          setTimeout(function(){ step = 1; render(); }, 400);
        }catch(e){
          $("#dot").className = "dot err";
          $("#stt").textContent = "Ошибка";
          err.classList.remove("hide");
          showErr(err, e);
        }
      };
      var u = sessionStorage.getItem("dauys_url");
      if(u) $("#url").value = u;
      return;
    }
    if(step === 1){
      var st1 = { hasToken: false, connection: "offline", paired: false };
      try { st1 = await api("/api/status"); } catch (e) { /* */ }
      var saved = !!st1.hasToken || sessionStorage.getItem("dauys_has_token") === "1";
      panel.innerHTML = htmlStep1(saved);
      var polling = false;
      async function poll(){
        if(polling) return;
        polling = true;
        try{
          while(step === 1){
            var s = await api("/api/setup/pair-status");
            if(s.agentOnline || s.paired){
              $("#pdot").className = "dot on";
              $("#ptxt").textContent = s.agentOnline ? "Агент подключён" : "Телефон привязан";
              $("#next").disabled = false;
              break;
            }
            await new Promise(function(r){ setTimeout(r, 2000); });
          }
        }catch(e){
          $("#pdot").className = "dot err";
          var err = $("#err");
          err.classList.remove("hide");
          showErr(err, e);
        }finally{
          polling = false;
        }
      }
      async function resumeSaved(){
        clearInterval(timer);
        $("#pdot").className = "dot wait";
        $("#ptxt").textContent = "Подключение к серверу";
        $("#next").disabled = true;
        try{
          var r = await api("/api/setup/ensure-connected", { method: "POST", body: "{}" });
          if (r.connection === "connected") {
            $("#pdot").className = "dot on";
            $("#ptxt").textContent = "Агент подключён";
            $("#next").disabled = false;
            return;
          }
          $("#ptxt").textContent = "Ожидаем соединение…";
          poll();
        }catch(e){
          $("#pdot").className = "dot err";
          $("#ptxt").textContent = "Нет соединения";
          var err = $("#err");
          err.classList.remove("hide");
          showErr(err, e);
        }
      }
      async function startPair(){
        clearInterval(timer);
        $("#pdot").className = "dot wait";
        $("#ptxt").textContent = "Подключение к серверу";
        $("#next").disabled = true;
        var boot = bootstrap;
        try{
          if (!saved && !boot.trim()) {
            throw new Error("Введите bootstrap-секрет с сервера. Поле нельзя оставлять пустым при первой привязке.");
          }
          var body = {
            serverUrl: sessionStorage.getItem("dauys_url") || "https://dauys.esl.kz"
          };
          if (boot.trim()) body.bootstrap = boot.trim();
          pair = await api("/api/setup/start-pair", {
            method: "POST",
            body: JSON.stringify(body)
          });
          var codeEl = $("#code");
          var cdEl = $("#cd");
          if (codeEl) {
            codeEl.classList.remove("hide");
            codeEl.textContent = pair.code;
          }
          if (cdEl) cdEl.classList.remove("hide");
          var note = $("#savedNote");
          if (note) note.classList.add("hide");
          $("#ptxt").textContent = "Ожидаем привязку телефона";
          function tick(){
            var left = Math.max(0, Math.floor((pair.expiresAt - Date.now()) / 1000));
            if ($("#cd")) $("#cd").textContent = left ? ("осталось " + left + " с") : "код истёк, запросите новый";
          }
          tick();
          timer = setInterval(tick, 1000);
          poll();
        }catch(e){
          $("#pdot").className = "dot err";
          $("#ptxt").textContent = "Ошибка привязки";
          var err = $("#err");
          err.classList.remove("hide");
          showErr(err, e);
        }
      }
      $("#retry").onclick = function(){ startPair(); };
      $("#next").onclick = function(){ step = 2; render(); };
      if (saved) resumeSaved();
      else startPair();
      return;
    }
    if(step === 2){
      panel.innerHTML = htmlStep2();
      async function refresh(){
        var s = await api("/api/status");
        $("#folders").textContent = (s.folders && s.folders.length) ? s.folders.join("\\n") : "Папки не выбраны";
      }
      refresh().catch(function(e){
        var err = $("#err");
        err.classList.remove("hide");
        showErr(err, e);
      });
      $("#add").onclick = async function(){
        try{
          await api("/api/setup/folders", { method: "POST", body: "{}" });
          await refresh();
        }catch(e){
          var err = $("#err");
          err.classList.remove("hide");
          showErr(err, e);
        }
      };
      $("#next").onclick = function(){ step = 3; render(); };
      return;
    }
    if(step === 3){
      panel.innerHTML = htmlStep3();
      async function load(force){
        try{
          var data = force
            ? await api("/api/setup/discover-apps", { method: "POST", body: "{}" })
            : await api("/api/status");
          var apps = data.apps || [];
          var list = $("#list");
          list.innerHTML = apps.map(function(a){
            return '<li data-id="' + String(a.id).replace(/"/g, "") + '">' +
              '<input class="toggle" type="checkbox" ' + (a.enabled ? "checked" : "") + "/>" +
              '<div><div class="name">' + String(a.name || "").replace(/</g, "&lt;") + "</div>" +
              '<div class="meta">' + (a.aliases || []).join(", ").replace(/</g, "&lt;") + "</div></div></li>";
          }).join("") || "<li>Ничего не найдено</li>";
        }catch(e){
          var err = $("#err");
          err.classList.remove("hide");
          showErr(err, e);
        }
      }
      await load(true);
      $("#rediscover").onclick = function(){ load(true); };
      $("#next").onclick = async function(){
        var apps = $$("#list li[data-id]").map(function(li){
          return { id: li.getAttribute("data-id"), enabled: !!$(".toggle", li).checked };
        });
        try{
          await api("/api/setup/save-apps", { method: "POST", body: JSON.stringify({ toggles: apps }) });
          step = 4;
          render();
        }catch(e){
          var err = $("#err");
          err.classList.remove("hide");
          showErr(err, e);
        }
      };
      return;
    }
    if(step === 4){
      panel.innerHTML = htmlStep4();
      $("#test").onclick = async function(){
        try{
          var r = await api("/api/setup/test-command", { method: "POST", body: "{}" });
          $("#out").textContent = r.message || JSON.stringify(r);
        }catch(e){
          var err = $("#err");
          err.classList.remove("hide");
          showErr(err, e);
        }
      };
      $("#done").onclick = async function(){
        try{
          await api("/api/setup/complete", { method: "POST", body: "{}" });
          panel.innerHTML = '<p class="ok">Настройка завершена. Можно закрыть это окно. Агент работает в трее.</p>';
        }catch(e){
          var err = $("#err");
          err.classList.remove("hide");
          showErr(err, e);
        }
      };
    }
  }
  render();
`;

const SETTINGS_MARKUP = `<h1>Dauys</h1>
<p class="sub">Настройки агента</p>
<div class="card" id="statusCard">Загрузка…</div>
<div class="card">
  <label>Адрес сервера</label>
  <input id="url" type="url"/>
  <div class="row">
    <button type="button" id="saveCfg">Сохранить</button>
    <button type="button" class="secondary" id="reconnect">Переподключить</button>
    <button type="button" class="secondary" id="pair">Новый код</button>
  </div>
  <div class="code hide" id="code"></div>
  <div class="countdown hide" id="cd"></div>
</div>
<div class="card">
  <label>Приложения</label>
  <ul class="apps" id="apps"></ul>
  <div class="row">
    <button type="button" class="secondary" id="rediscover">Найти приложения</button>
    <button type="button" id="saveApps">Сохранить приложения</button>
  </div>
</div>
<div class="card">
  <label>Папки</label>
  <div class="folders mono" id="folders"></div>
  <div class="row"><button type="button" class="secondary" id="addFolder">Добавить папку</button></div>
</div>
<div class="card">
  <div class="row">
    <button type="button" class="secondary" id="autostart">Автозапуск</button>
    <button type="button" class="secondary" id="log">Журнал</button>
    <button type="button" class="secondary" id="quit">Выйти</button>
  </div>
</div>
<div class="card">
  <label>Недавние операции</label>
  <pre class="mono" id="ops" style="white-space:pre-wrap;color:var(--muted);margin:0"></pre>
</div>
<div class="err hide" id="err"></div>`;

const SETTINGS_SCRIPT = `
  var api = window.dauysApi;
  var $ = window.dauys$;
  var $$ = window.dauys$$;
  var err = $("#err");
  function show(e){
    err.classList.remove("hide");
    err.textContent = e instanceof Error ? e.message : String(e);
  }
  function esc(s){ return String(s || "").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }
  async function refresh(){
    var s = await api("/api/status");
    var dot = s.connection === "connected" ? "on" : (s.connection === "error" ? "err" : "wait");
    $("#statusCard").innerHTML =
      '<div class="status"><span class="dot ' + dot + '"></span>' +
      "<span>" + esc(s.connection) + " · " + (s.paired ? "телефон привязан" : "нет привязки") +
      " · v" + esc(s.version || "?") + "</span></div>" +
      '<p class="mono" style="margin:8px 0 0;color:var(--muted)">' + esc(s.server || "") + "</p>";
    $("#url").value = s.server || "";
    $("#folders").textContent = (s.folders && s.folders.length) ? s.folders.join("\\n") : "нет выбранных папок";
    $("#autostart").textContent = s.autostart ? "Автозапуск: вкл" : "Автозапуск: выкл";
    $("#ops").textContent = (s.recentOps && s.recentOps.length)
      ? s.recentOps.map(function(o){ return o.at + "  " + o.action + "  " + o.message; }).join("\\n")
      : "нет";
    $("#apps").innerHTML = (s.apps || []).map(function(a){
      return '<li data-id="' + esc(a.id) + '">' +
        '<input class="toggle" type="checkbox" ' + (a.enabled ? "checked" : "") + "/>" +
        '<div style="flex:1"><div class="name">' + esc(a.name) + "</div>" +
        '<input class="aliases" type="text" value="' + esc((a.aliases || []).join(", ")) +
        '" style="margin-top:6px"/></div></li>';
    }).join("") || "<li>пусто</li>";
  }
  refresh().catch(show);
  $("#saveCfg").onclick = async function(){
    try{
      await api("/api/save-config", { method: "POST", body: JSON.stringify({ serverUrl: $("#url").value.trim() }) });
      await refresh();
    }catch(e){ show(e); }
  };
  $("#reconnect").onclick = async function(){
    try{ await api("/api/reconnect", { method: "POST", body: "{}" }); await refresh(); }catch(e){ show(e); }
  };
  $("#pair").onclick = async function(){
    try{
      var p = await api("/api/pair-again", { method: "POST", body: "{}" });
      $("#code").classList.remove("hide");
      $("#cd").classList.remove("hide");
      $("#code").textContent = p.code;
      function tick(){
        var left = Math.max(0, Math.floor((p.expiresAt - Date.now()) / 1000));
        $("#cd").textContent = left ? ("осталось " + left + " с") : "истёк";
      }
      tick();
      setInterval(tick, 1000);
    }catch(e){ show(e); }
  };
  $("#rediscover").onclick = async function(){
    try{ await api("/api/setup/discover-apps", { method: "POST", body: "{}" }); await refresh(); }catch(e){ show(e); }
  };
  $("#saveApps").onclick = async function(){
    try{
      var apps = $$("#apps li[data-id]").map(function(li){
        return {
          id: li.getAttribute("data-id"),
          enabled: !!$(".toggle", li).checked,
          aliases: $(".aliases", li).value.split(",").map(function(x){ return x.trim(); }).filter(Boolean)
        };
      });
      await api("/api/update-apps", { method: "POST", body: JSON.stringify({ apps: apps }) });
      await refresh();
    }catch(e){ show(e); }
  };
  $("#addFolder").onclick = async function(){
    try{ await api("/api/setup/folders", { method: "POST", body: "{}" }); await refresh(); }catch(e){ show(e); }
  };
  $("#autostart").onclick = async function(){
    try{ await api("/api/toggle-autostart", { method: "POST", body: "{}" }); await refresh(); }catch(e){ show(e); }
  };
  $("#log").onclick = async function(){
    try{ await api("/api/open-log", { method: "POST", body: "{}" }); }catch(e){ show(e); }
  };
  $("#quit").onclick = async function(){
    try{ await api("/api/quit", { method: "POST", body: "{}" }); }catch(e){ show(e); }
  };
`;

export function wizardHtml() {
  return shell("Dauys: настройка", WIZARD_MARKUP, WIZARD_SCRIPT);
}

export function settingsHtml() {
  return shell("Dauys: настройки", SETTINGS_MARKUP, SETTINGS_SCRIPT);
}

/** Test helper: ensure helpers appear before page logic and panel markup exists. */
export function assertWizardHtmlOrder(html: string) {
  const helperIdx = html.indexOf("async function api");
  const panelIdx = html.indexOf('id="panel"');
  const renderIdx = html.indexOf("render();");
  if (panelIdx < 0) throw new Error("wizard missing #panel");
  if (helperIdx < 0) throw new Error("wizard missing api helper");
  if (renderIdx < 0) throw new Error("wizard missing render()");
  if (!(helperIdx < renderIdx))
    throw new Error("api helper must be defined before render()");
}
