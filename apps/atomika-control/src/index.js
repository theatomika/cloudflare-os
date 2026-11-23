// La clase del Workflow debe estar exportada por el entrypoint del panel:
// es la misma fuente que despliega el worker del Workflow (apps/atomika-control-workflow).
export { AtomikaControlFlow } from "../../atomika-control-workflow/src/index.js";

/**
 * ATOMIKA Control OS · panel de dirección (Worker).
 *
 * Sirve la interfaz de revisión y expone una API mínima sobre fuentes REALES:
 *
 *   - Linear      → issues de control (ATO-506/513/514/524/526/568) y su último comentario
 *   - GitHub      → repo canónico, rama, commits, PRs y estado de CI
 *   - Multica     → runs y agentes (con latido) del workspace
 *   - Cloudflare  → workers, workflows e instancias, KV, apps de Access
 *   - Piloto      → estado real del host (T3/DSH/evidencia) que el adaptador publica
 *   - Workflows   → instancia por tarea (autoridad durable del gate C-G2)
 *
 * Autorización: la aplicación está detrás de Cloudflare Access; además el Worker exige
 * una identidad known (email de la política allow) para las acciones de escritura.
 * Las rutas de máquina (adaptador) usan un Bearer propio.
 */

const KV = "CTL";
const WORKFLOW_BINDING = "ATOMIKA_CONTROL_FLOW";
const LINEAR_ISSUES = ["ATO-506", "ATO-513", "ATO-514", "ATO-524", "ATO-526", "ATO-568"];
const CONTROL_EMAILS = ["thehubshopz@gmail.com"];

function json(code, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

async function readJson(req) {
  const raw = await new Response(req.body).text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Hostnames en los que Access valida la identidad antes de llegar al Worker.
 * FUERA de este listado (p. ej. workers.dev) las cabeceras Cf-Access-* son falsificables
 * por el cliente: no se deben confiar. Ahí, la única vía es el secreto de máquina.
 */
const ACCESS_PROTECTED_HOSTS = ["control.atomika.dev"];

function identityOf(req) {
  const host = String(req.headers.get("host") || "").split(":")[0];
  const trusted = ACCESS_PROTECTED_HOSTS.includes(host);
  const email = trusted
    ? (req.headers.get("cf-access-authenticated-user-email") || "").toLowerCase()
    : "";
  return {
    email,
    trusted,
    host,
    serviceToken: trusted && Boolean(req.headers.get("cf-access-client-id")),
  };
}

function isAuthorized(identity) {
  return CONTROL_EMAILS.includes(identity.email);
}

/**
 * Toda ruta de DIRECCIÓN (lectura y escritura) exige identidad de Accessrecognized.
 * El hostname workers.dev no está detrás de Access, así que sin cabecera de identidad
 * la API responde 403: así el endpoint público no expone datos del proyecto.
 */
function requireIdentity(identity) {
  if (isAuthorized(identity) && identity.trusted) return null;
  return json(403, {
    error: "identidad requerida (Cloudflare Access)",
    hint: "accede por el hostname protegido por Access o usa las rutas de máquina con su secreto",
  });
}

/* ------------------------------------------------------------------ Integraciones */

async function linearState(env) {
  if (!env.LINEAR_API_KEY) return { ok: false, error: "sin credencial Linear" };
  const query = `query($id:String!){ issue(id:$id){ identifier title state{ name type } updatedAt url
      comments(first:1){ nodes{ body createdAt } } } }`;
  const issues = await Promise.all(
    LINEAR_ISSUES.map(async (id) => {
      try {
        const res = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: env.LINEAR_API_KEY },
          body: JSON.stringify({ query, variables: { id } }),
        });
        const data = await res.json();
        const n = data?.data?.issue;
        if (!n) return null;
        return {
          identifier: n.identifier,
          title: n.title,
          state: n.state?.name,
          state_type: n.state?.type,
          updated_at: n.updatedAt,
          url: n.url,
          last_comment: (n.comments?.nodes?.[0]?.body || "").slice(0, 400),
          last_comment_at: n.comments?.nodes?.[0]?.createdAt || null,
        };
      } catch {
        return null;
      }
    }),
  );
  return {
    ok: true,
    fetched_at: new Date().toISOString(),
    issues: issues.filter(Boolean),
  };
}

async function githubState(env) {
  if (!env.GITHUB_TOKEN) return { ok: false, error: "sin credencial GitHub" };
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "atomika-control-os",
  };
  const repo = "theatomika/atomika-control";
  const base = `https://api.github.com/repos/${repo}`;
  const [repoRes, commitsRes, prsRes] = await Promise.all([
    fetch(base, { headers }),
    fetch(`${base}/commits?sha=feat/ato514-t3-dsh-lab-20261123&per_page=5`, { headers }),
    fetch(`${base}/pulls?state=open&per_page=10`, { headers }),
  ]);
  if (!repoRes.ok) return { ok: false, error: `github http ${repoRes.status}` };
  const repoJson = await repoRes.json();
  const commits = commitsRes.ok ? await commitsRes.json() : [];
  const prs = prsRes.ok ? await prsRes.json() : [];
  let checkRuns = null;
  if (commits[0]) {
    const cRes = await fetch(`${base}/commits/${commits[0].sha}/check-runs`, { headers });
    if (cRes.ok) {
      const c = await cRes.json();
      checkRuns = (c.check_runs || []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
    }
  }
  return {
    ok: true,
    fetched_at: new Date().toISOString(),
    repo: repoJson.full_name,
    private: repoJson.private,
    default_branch: repoJson.default_branch,
    pushed_at: repoJson.pushed_at,
    branch: "feat/ato514-t3-dsh-lab-20261123",
    head: commits[0] ? { sha: commits[0].sha, message: commits[0].commit.message.split("\n")[0], date: commits[0].commit.author.date } : null,
    commits: commits.map((c) => ({
      sha: c.sha.slice(0, 12),
      message: c.commit.message.split("\n")[0],
      date: c.commit.author.date,
    })),
    open_prs: prs.map((p) => ({ number: p.number, title: p.title, draft: p.draft, url: p.html_url })),
    check_runs: checkRuns,
  };
}

async function multicaState(env) {
  if (!env.MULTICA_TOKEN) return { ok: false, error: "sin credencial Multica" };
  const headers = { authorization: `Bearer ${env.MULTICA_TOKEN}`, "content-type": "application/json" };
  const base = "https://api.multica.ai/api";
  const workspace = env.MULTICA_WORKSPACE_ID || "1b869bee-4a67-4d37-8e8e-b82d6e12707f";
  const [issuesRes, agentsRes] = await Promise.all([
    fetch(`${base}/issues?workspace_id=${workspace}&limit=10`, { headers }),
    fetch(`${base}/agents?workspace_id=${workspace}`, { headers }),
  ]);
  const out = { ok: true, fetched_at: new Date().toISOString(), workspace };
  if (issuesRes.ok) {
    const j = await issuesRes.json();
    const list = Array.isArray(j) ? j : j.issues || j.data || [];
    out.issues = list.slice(0, 10).map((i) => ({
      identifier: i.identifier,
      title: i.title,
      status: i.status,
      assignee: i.assignee_name || (i.assignee && i.assignee.name) || i.assignee_id || null,
      updated_at: i.updated_at,
    }));
  } else {
    out.issues_error = `http ${issuesRes.status}`;
  }
  if (agentsRes.ok) {
    const j = await agentsRes.json();
    const list = Array.isArray(j) ? j : j.agents || j.data || [];
    out.agents = list.slice(0, 14).map((a) => ({
      id: a.id,
      name: a.name,
      model: a.model,
      max_concurrent_tasks: a.max_concurrent_tasks,
    }));
  } else {
    out.agents_error = `http ${agentsRes.status}`;
  }
  return out;
}

async function cloudflareState(env) {
  if (!env.CLOUDFLARE_API_TOKEN) return { ok: false, error: "sin credencial Cloudflare" };
  const headers = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const [workersRes, workflowsRes, appsRes] = await Promise.all([
    fetch(`${base}/workers/scripts`, { headers }),
    fetch(`${base}/workflows`, { headers }),
    fetch(`${base}/access/apps?per_page=50`, { headers }),
  ]);
  const out = { ok: true, fetched_at: new Date().toISOString(), account };
  if (workersRes.ok) out.workers = (await workersRes.json()).result.map((w) => w.id);
  if (workflowsRes.ok) {
    const res = await workflowsRes.json();
    out.workflows = (res.result || []).map((w) => ({
      id: w.id,
      name: w.name || w.workflow_name || w.id,
      created_on: w.created_on,
      modified_on: w.modified_on,
      instances: [],
    }));
    // instancias reales del workflow (autoridad durable): estado y terminación
    for (const w of out.workflows) {
      try {
        const instRes = await fetch(`${base}/workflows/${encodeURIComponent(w.name)}/instances?per_page=25`, { headers });
        if (instRes.ok) {
          const inst = await instRes.json();
          w.instances = (inst.result || []).map((i) => ({
            id: i.id,
            status: i.status,
            created_on: i.created_on,
            terminated_on: i.terminated_on,
            error: i.error ? String(i.error).slice(0, 120) : null,
          }));
        }
      } catch {
        /* sin instancias legibles */
      }
    }
  }
  if (appsRes.ok) {
    const res = await appsRes.json();
    out.access_apps = (res.result || [])
      .filter((a) => /atomika/i.test(a.name || "") || /atomika/i.test(a.domain || ""))
      .map((a) => ({ name: a.name, domain: a.domain, id: a.id }));
  }
  return out;
}

async function pilotState(env) {
  const raw = await env[KV].get("ctl:pilot:state");
  if (!raw) return { ok: false, error: "el adaptador aún no ha publicado estado" };
  try {
    return { ok: true, ...JSON.parse(raw) };
  } catch {
    return { ok: false, error: "estado del piloto ilegible" };
  }
}

async function tasksList(env) {
  const tasks = [];
  const listed = await env[KV].list({ prefix: "ctl:task:" });
  for (const key of listed.keys || []) {
    try {
      tasks.push(JSON.parse(await env[KV].get(key.name)));
    } catch {
      /* ignore */
    }
  }
  tasks.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return tasks;
}

async function checkpointOf(env, taskId) {
  const raw = await env[KV].get(`ctl:checkpoint:${taskId}`);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- Router */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* --- máquina (adaptador del host) ------------------------------------- */
    if (path.startsWith("/api/machine/")) {
      const bearer = request.headers.get("authorization") || "";
      const readOnly = Boolean(env.READ_KEY) && bearer === `Bearer ${env.READ_KEY}`;
      const machine = Boolean(env.ADAPTER_KEY) && bearer === `Bearer ${env.ADAPTER_KEY}`;
      if (!readOnly && !machine) {
        return json(401, { error: "no autorizado" });
      }
      // La credencial de solo lectura NO puede despachar ni escribir resultados.
      if (readOnly && request.method !== "GET") {
        return json(403, { error: "credencial de solo lectura" });
      }
      if (path === "/api/machine/state" && request.method === "GET") {
        // Solo lectura: la usa el revisor independiente para verificar el estado real.
        const [linear, github, multica, cloudflare, pilot, tasks] = await Promise.all([
          linearState(env),
          githubState(env),
          multicaState(env),
          cloudflareState(env),
          pilotState(env),
          tasksList(env),
        ]);
        const checkpoints = {};
        for (const t of tasks.slice(0, 10)) {
          checkpoints[t.task_id] = await checkpointOf(env, t.task_id);
        }
        return json(200, {
          generated_at: new Date().toISOString(),
          linear,
          github,
          multica,
          cloudflare,
          pilot,
          tasks,
          checkpoints,
        });
      }

      if (path.startsWith("/api/machine/crash/") && request.method === "POST") {
        // Marca la tarea para que el ejecutor aplique el efecto y MUERA (SIGKILL) antes de
        // responder: es la prueba real de caída y recuperación con checkpoint durable.
        const taskId = path.split("/")[4];
        await env[KV].put(`ctl:crash:${taskId}`, JSON.stringify({ at: new Date().toISOString() }));
        return json(200, { ok: true, task_id: taskId, mode: "crash" });
      }

      if (path === "/api/machine/poll" && request.method === "POST") {
        // KV en Workers no es async-iterable: list() devuelve { keys, list_complete, cursor }.
        const pending = [];
        const now = Date.now();
        const listed = await env[KV].list({ prefix: "ctl:dispatch:" });
        for (const key of listed.keys || []) {
          try {
            const rec = JSON.parse(await env[KV].get(key.name));
            const hasResult = Boolean(await env[KV].get(`ctl:result:${rec.task_id}`));
            const dispatchedAt = Date.parse(rec.dispatched_at || rec.created_at || 0);
            const stale = now - dispatchedAt > 20000; // el ejecutor pudo morir a mitad
            const claimable = rec.state === "pending" || (rec.state === "dispatched" && stale && !hasResult);
            if (claimable) {
              // Puerta de aprobación: una tarea que exige aprobación humana NO se despacha
              // al ejecutor hasta que existe una decisión "approved" registrada. El Workflow
              // es la autoridad, pero el ejecutor tampoco puede adelantarse.
              if (rec.require_approval) {
                const approvalRaw = await env[KV].get(`ctl:approval:${rec.task_id}`);
                let approved = false;
                try {
                  approved = Boolean(approvalRaw) && JSON.parse(approvalRaw).decision === "approved";
                } catch {
                  approved = false;
                }
                if (!approved) continue;
              }
              const crashFlag = await env[KV].get(`ctl:crash:${rec.task_id}`);
              pending.push({ ...rec, crash: Boolean(crashFlag), reclaimed: rec.state === "dispatched" });
              if (crashFlag) await env[KV].delete(`ctl:crash:${rec.task_id}`);
              await env[KV].put(
                key.name,
                JSON.stringify({
                  ...rec,
                  state: "dispatched",
                  dispatched_at: new Date().toISOString(),
                  reclaims: (rec.reclaims || 0) + (rec.state === "dispatched" ? 1 : 0),
                }),
              );
            }
          } catch {
            /* ignore */
          }
        }
        return json(200, { tasks: pending });
      }
      if (path === "/api/machine/result" && request.method === "POST") {
        const body = await readJson(request);
        const taskId = String(body.task_id || "");
        if (!taskId) return json(400, { error: "task_id obligatorio" });
        await env[KV].put(`ctl:result:${taskId}`, JSON.stringify({ ...body, received_at: new Date().toISOString() }));
        return json(200, { ok: true });
      }
      if (path === "/api/machine/state" && request.method === "POST") {
        const body = await readJson(request);
        await env[KV].put(
          "ctl:pilot:state",
          JSON.stringify({ ...body, fetched_at: new Date().toISOString() }),
        );
        return json(200, { ok: true });
      }
      return json(404, { error: "no encontrado" });
    }

    /* --- API de dirección -------------------------------------------------- */
    if (path === "/api/state") {
      const denied = requireIdentity(identityOf(request));
      if (denied) return denied;
      const [linear, github, multica, cloudflare, pilot, tasks] = await Promise.all([
        linearState(env),
        githubState(env),
        multicaState(env),
        cloudflareState(env),
        pilotState(env),
        tasksList(env),
      ]);
      const checkpoints = {};
      for (const t of tasks.slice(0, 10)) {
        checkpoints[t.task_id] = await checkpointOf(env, t.task_id);
      }
      return json(200, {
        generated_at: new Date().toISOString(),
        identity: identityOf(request),
        linear,
        github,
        multica,
        cloudflare,
        pilot,
        tasks,
        checkpoints,
        costs: {
          measured: false,
          note: "coste monetario NO MEDIDO: las APIs disponibles exponen tokens, no precio",
          measurable_now: ["tokens de las runs de Multica", "uso de la API DeepSeek por tarea"],
        },
      });
    }

    if (path === "/api/tasks" && request.method === "GET") {
      const denied = requireIdentity(identityOf(request));
      if (denied) return denied;
      return json(200, { tasks: await tasksList(env) });
    }

    if (path === "/api/tasks" && request.method === "POST") {
      const identity = identityOf(request);
      // Se acepta una identidad de Access o la credencial de máquina de lanzamiento.
      // Las APROBACIONES humanas siguen exigiendo identidad de Access sin excepción.
      const machineLaunch =
        Boolean(env.LAUNCH_KEY) &&
        (request.headers.get("authorization") || "") === `Bearer ${env.LAUNCH_KEY}`;
      if (!isAuthorized(identity) && !machineLaunch) {
        return json(403, { error: "identidad no autorizada para lanzar tareas" });
      }
      const body = await readJson(request);
      const instruction = String(body.instruction || "").trim();
      if (!instruction) return json(400, { error: "instruction obligatoria" });
      const requireApproval = Boolean(body.require_approval);
      const idempotencyKey = body.idempotency_key
        ? String(body.idempotency_key)
        : `idem:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

      // Idempotencia de la API: la misma idempotency_key devuelve SIEMPRE la misma tarea
      // y la misma instancia de Workflow (no se crea una segunda ejecución).
      const idemRef = `ctl:idem:${idempotencyKey}`;
      const existing = await env[KV].get(idemRef);
      if (existing) {
        try {
          const rec = JSON.parse(existing);
          return json(200, {
            task_id: rec.task_id,
            instance_id: rec.instance_id,
            idempotency_key: idempotencyKey,
            require_approval: rec.require_approval,
            duplicate: true,
            note: "idempotency_key ya registrada: se devuelve la ejecución existente",
          });
        } catch {
          /* si el registro está corrupto, se continúa como nueva */
        }
      }

      const taskId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      // id de instancia determinista SOLO por la clave de idempotencia.
      const instanceId = `ctl-${idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48)}`;

      await env[KV].put(
        idemRef,
        JSON.stringify({
          task_id: taskId,
          instance_id: instanceId,
          idempotency_key: idempotencyKey,
          require_approval: requireApproval,
          at: new Date().toISOString(),
        }),
      );

      await env[KV].put(
        `ctl:task:${taskId}`,
        JSON.stringify({
          task_id: taskId,
          status: "PENDING",
          instruction,
          idempotency_key: idempotencyKey,
          instance_id: instanceId,
          require_approval: requireApproval,
          created_by: identity.email || "machine:launch-key",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      );
      if (body.crash === true) {
        // Modo de prueba de caída: el ejecutor aplica el efecto y muere antes de responder.
        await env[KV].put(`ctl:crash:${taskId}`, JSON.stringify({ at: new Date().toISOString() }));
      }
      await env[KV].put(
        `ctl:dispatch:${taskId}`,
        JSON.stringify({
          task_id: taskId,
          state: "pending",
          instruction,
          require_approval: requireApproval,
          idempotency_key: idempotencyKey,
          created_at: new Date().toISOString(),
        }),
      );

      let instance = null;
      try {
        instance = await env[WORKFLOW_BINDING].create({
          id: instanceId,
          params: { task_id: taskId, idempotency_key: idempotencyKey, instruction, require_approval: requireApproval },
        });
      } catch (e) {
        return json(409, { error: `workflow: ${String(e).slice(0, 200)}`, task_id: taskId });
      }
      return json(201, {
        task_id: taskId,
        instance_id: instance.id,
        idempotency_key: idempotencyKey,
        require_approval: requireApproval,
      });
    }

    if (path.startsWith("/api/approvals/") && request.method === "POST") {
      const identity = identityOf(request);
      if (!isAuthorized(identity)) {
        return json(403, { error: "identidad no autorizada para aprobar" });
      }
      const taskId = path.split("/")[3];
      const body = await readJson(request);
      const decision = body.decision === "rejected" ? "rejected" : "approved";
      // Una aprobación consumida no se puede reutilizar: el Workflow la marca al avanzar.
      const previousRaw = await env[KV].get(`ctl:approval:${taskId}`);
      if (previousRaw) {
        try {
          const previous = JSON.parse(previousRaw);
          if (previous.consumed && decision === "approved") {
            return json(409, {
              error: "aprobación ya consumida por el Workflow: no puede volver a avanzar la tarea",
              task_id: taskId,
              consumed_at: previous.consumed_at || null,
            });
          }
        } catch {
          /* registro ilegible: se continúa */
        }
      }
      await env[KV].put(
        `ctl:approval:${taskId}`,
        JSON.stringify({
          task_id: taskId,
          decision,
          by: identity.email,
          at: new Date().toISOString(),
          consumed: false,
        }),
      );
      return json(200, { ok: true, task_id: taskId, decision });
    }

    if (path.startsWith("/api/checkpoint/")) {
      const denied = requireIdentity(identityOf(request));
      if (denied) return denied;
      const taskId = path.split("/")[3];
      return json(200, { checkpoint: await checkpointOf(env, taskId) });
    }

    /* --- interfaz ---------------------------------------------------------- */
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return json(404, { error: "no encontrado" });
  },
};
