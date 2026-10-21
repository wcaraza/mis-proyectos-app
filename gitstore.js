/* gitstore.js — almacén de archivos de texto en un repositorio privado de GitHub.
 *
 * Reutilizable en cualquier app personal (PWA) que guarde sus datos como
 * archivos (Markdown, JSON...) en un repo. Sin dependencias.
 *
 *   const store = new GitStore({owner, repo, token, branch: "main"});
 *   const files = await store.list("estados");          // [{path, name, sha}]
 *   const {text, sha} = await store.read("estados/x.md");
 *   await store.write("estados/x.md", texto, sha, "Mensaje del commit");
 *   await store.update("estados/x.md", texto => nuevoTexto, "Mensaje");  // reintenta si hay conflicto
 *
 * - Caché local por sha (localStorage): solo descarga lo que cambió y permite
 *   abrir la app sin conexión con los últimos datos.
 * - Cola de cambios pendientes: si no hay red, update() guarda la operación y
 *   flush() la reintenta más tarde.
 * El token debe ser un "fine-grained token" con permiso Contents: Read and write
 * SOLO sobre el repo de datos. Se guarda únicamente en este dispositivo.
 */
(function (global) {
  const API = "https://api.github.com";
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64encode = (text) => { let s = ""; for (const b of enc.encode(text)) s += String.fromCharCode(b); return btoa(s); };
  const b64decode = (b64) => dec.decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };

  class GitError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  class GitStore {
    constructor({ owner, repo, token, branch = "main", cacheKey }) {
      Object.assign(this, { owner, repo, token, branch });
      this.cacheKey = cacheKey || `gitstore:${owner}/${repo}`;
      this.cache = safe(() => JSON.parse(localStorage.getItem(this.cacheKey)) || {}, {});
      this.cache.files ||= {};   // path -> {sha, text}
      this.cache.lists ||= {};   // dir  -> [{path,name,sha}]
      this.cache.pending ||= []; // [{path, op, message, t}]
    }
    _save() { safe(() => localStorage.setItem(this.cacheKey, JSON.stringify(this.cache))); }

    async _api(path, opts = {}) {
      let r;
      try {
        r = await fetch(API + path, {
          ...opts,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
          },
          cache: "no-store",
        });
      } catch (e) { throw new GitError(0, "Sin conexión"); }
      if (r.status === 404 && opts.allow404) return null;
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const msg = { 401: "Token no válido o caducado", 403: "El token no tiene permiso sobre este repositorio", 404: "No encuentro el repositorio o el archivo" }[r.status] || j.message || `Error ${r.status}`;
        throw new GitError(r.status, msg);
      }
      return r.status === 204 ? null : r.json();
    }

    /** Comprueba token y repo. Devuelve {private, full_name}. */
    async check() {
      const j = await this._api(`/repos/${this.owner}/${this.repo}`);
      return { private: j.private, full_name: j.full_name, branch: j.default_branch };
    }

    /** Lista los archivos de una carpeta. Sin conexión devuelve la última lista conocida. */
    async list(dir) {
      try {
        const j = await this._api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(dir)}?ref=${this.branch}`, { allow404: true });
        const items = (j || []).filter((x) => x.type === "file").map((x) => ({ path: x.path, name: x.name, sha: x.sha }));
        this.cache.lists[dir] = items; this._save();
        return { items, offline: false };
      } catch (e) {
        if (e.status === 0 && this.cache.lists[dir]) return { items: this.cache.lists[dir], offline: true };
        throw e;
      }
    }

    /** Lee un archivo. Usa la caché si el sha coincide. */
    async read(path, knownSha) {
      const c = this.cache.files[path];
      if (c && knownSha && c.sha === knownSha) return { text: c.text, sha: c.sha, cached: true };
      try {
        const j = await this._api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(path)}?ref=${this.branch}`, { allow404: true });
        if (!j) return null;
        const text = b64decode(j.content);
        this.cache.files[path] = { sha: j.sha, text }; this._save();
        return { text, sha: j.sha };
      } catch (e) {
        if (e.status === 0 && c) return { text: c.text, sha: c.sha, cached: true, offline: true };
        throw e;
      }
    }

    /** Escribe (crea si sha es null). Lanza GitError 409/422 si alguien cambió el archivo antes. */
    async write(path, text, sha, message) {
      const j = await this._api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(path)}`, {
        method: "PUT",
        body: JSON.stringify({ message, content: b64encode(text), branch: this.branch, ...(sha ? { sha } : {}) }),
      });
      this.cache.files[path] = { sha: j.content.sha, text }; this._save();
      return j.content.sha;
    }

    /**
     * Aplica un cambio sobre la versión MÁS RECIENTE del archivo: lee, llama a
     * mutate(textoActual) -> textoNuevo y escribe; si otro dispositivo escribió
     * entre medias, vuelve a leer y reaplica (hasta 3 veces).
     * Sin conexión, guarda el cambio en la cola (pendingOp) y devuelve {queued:true}.
     * `pendingOp` es un objeto serializable que tu app sabe reaplicar en flush().
     */
    async update(path, mutate, message, pendingOp) {
      for (let i = 0; i < 3; i++) {
        try {
          const cur = await this._api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(path)}?ref=${this.branch}`, { allow404: true });
          const curText = cur ? b64decode(cur.content) : null;
          const next = mutate(curText);
          if (next == null || next === curText) return { unchanged: true };
          await this.write(path, next, cur?.sha, message);
          return { ok: true };
        } catch (e) {
          if (e.status === 409 || e.status === 422) continue;          // conflicto: reintenta
          if (e.status === 0 && pendingOp) {                             // sin red: a la cola
            this.cache.pending.push({ path, op: pendingOp, message, t: Date.now() }); this._save();
            const c = this.cache.files[path];                            // aplica en local para verlo ya
            if (c) { const n = mutate(c.text); if (n != null) { c.text = n; this._save(); } }
            return { queued: true };
          }
          throw e;
        }
      }
      throw new GitError(409, "El archivo cambió varias veces seguidas. Inténtalo de nuevo.");
    }

    get pendingCount() { return this.cache.pending.length; }

    /** Reintenta los cambios en cola. applyOp(op) debe devolver la función mutate. */
    async flush(applyOp) {
      const queue = [...this.cache.pending]; let done = 0;
      for (const p of queue) {
        try {
          await this.update(p.path, applyOp(p.op), p.message);
          this.cache.pending = this.cache.pending.filter((x) => x.t !== p.t);
          this._save(); done++;
        } catch (e) { if (e.status === 0) break; else { this.cache.pending = this.cache.pending.filter((x) => x.t !== p.t); this._save(); } }
      }
      return done;
    }
  }

  global.GitStore = GitStore;
  global.GitError = GitError;
})(window);
