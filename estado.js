/* estado.js — lee y escribe el formato ESTADO.md (mismo formato que server.py). */
(function (global) {
  const ESTADOS = ["Idea", "Evaluando", "En curso", "En producción", "Pausado", "Completado"];
  const PRIOS = ["Alta", "Media", "Baja"];
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const CAMPOS = { "categoria": "categoria", "estado": "estado", "prioridad": "prioridad", "proximo paso": "proximo_paso", "actualizado": "actualizado", "enlace": "enlace" };
  const ETIQUETAS = [["categoria", "Categoría"], ["estado", "Estado"], ["prioridad", "Prioridad"], ["proximo_paso", "Próximo paso"], ["actualizado", "Actualizado"], ["enlace", "Enlace"]];

  function parse(text) {
    const out = {}; let sec = null; const notas = [], resumen = [], tareas = [];
    for (const raw of (text || "").split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, "");
      if (line.startsWith("# ") && !("nombre" in out)) { out.nombre = line.slice(2).trim(); continue; }
      if (line.startsWith("## ")) { sec = norm(line.slice(3)); continue; }
      if (sec === null) {
        const m = line.match(/^\s*[-*]?\s*\**([^:*]+?)\**\s*:\s*\**\s*(.*)$/);
        if (m && CAMPOS[norm(m[1])]) out[CAMPOS[norm(m[1])]] = m[2].trim();
      } else if (sec.startsWith("tarea")) {
        const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/);
        if (m) tareas.push({ texto: m[2].trim(), hecho: m[1] !== " " });
      } else if (sec.startsWith("resumen")) resumen.push(line);
      else if (sec.startsWith("nota")) notas.push(line);
    }
    out.tareas = tareas; out.resumen = resumen.join("\n").trim(); out.notas = notas.join("\n").trim();
    for (const [k, valid] of [["estado", ESTADOS], ["prioridad", PRIOS]]) {
      if (k in out) { const v = valid.find((x) => norm(x) === norm(out[k])); if (v) out[k] = v; else delete out[k]; }
    }
    return out;
  }

  function render(p) {
    const L = [`# ${p.nombre || ""}`, ""];
    for (const [k, label] of ETIQUETAS) L.push(`- **${label}:** ${p[k] || ""}`.replace(/\s+$/, ""));
    L.push("", "## Resumen", p.resumen || "", "", "## Tareas");
    for (const t of p.tareas || []) L.push(`- [${t.hecho ? "x" : " "}] ${t.texto}`);
    L.push("", "## Notas", p.notas || "", "");
    return L.join("\n");
  }

  /** Diferencia entre dos versiones de un proyecto -> operación reaplicable. */
  function diff(antes, despues) {
    const op = { set: {}, toggle: {}, add: [], remove: [] };
    for (const k of ["nombre", "categoria", "estado", "prioridad", "proximo_paso", "resumen", "notas", "enlace"])
      if ((antes[k] || "") !== (despues[k] || "")) op.set[k] = despues[k] || "";
    const A = new Map((antes.tareas || []).map((t) => [t.texto, t.hecho]));
    const D = new Map((despues.tareas || []).map((t) => [t.texto, t.hecho]));
    for (const [t, h] of D) { if (!A.has(t)) op.add.push({ texto: t, hecho: h }); else if (A.get(t) !== h) op.toggle[t] = h; }
    for (const t of A.keys()) if (!D.has(t)) op.remove.push(t);
    return op;
  }

  /** Aplica una operación sobre el texto MÁS RECIENTE del archivo. */
  function apply(op, text, hoy) {
    const p = text ? parse(text) : { tareas: [] };
    Object.assign(p, op.set || {});
    p.tareas = (p.tareas || []).filter((t) => !(op.remove || []).includes(t.texto));
    for (const t of p.tareas) if (t.texto in (op.toggle || {})) t.hecho = op.toggle[t.texto];
    for (const n of op.add || []) if (!p.tareas.some((t) => t.texto === n.texto)) p.tareas.push(n);
    p.actualizado = hoy;
    return render(p);
  }

  global.Estado = { parse, render, diff, apply, ESTADOS, PRIOS };
})(window);
