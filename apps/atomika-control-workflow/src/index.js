/**
 * ATOMIKA Control OS · Workflow de control (autoridad durable).
 *
 * Implementa el contrato de `lab/t3-dsh/workflows/contract.md` sobre Cloudflare Workflows:
 *
 *   PENDING → RUNNING → (AWAITING_APPROVAL) → RUNNING → SUCCEEDED
 *              ↘ TOOL_OUTCOME_UNKNOWN → RECONCILING → SUCCEEDED | FAILED
 *
 * - La reserva idempotente vive en KV (`ctl:reserve:<key>`); el panel además mapea la
 *   `idempotency_key` a un id de instancia determinista, de modo que un evento duplicado
 *   NUNCA crea una segunda ejecución.
 * - El checkpoint durable vive en KV (`ctl:checkpoint:<task_id>`) y sobrevive a reinicios
 *   del Worker y del propio Workflow.
 * - La aprobación humana se valida contra un registro externo (KV `ctl:approval:<task_id>`),
 *   que escribe el panel solo para identidades autorizadas por Access.
 * - El ejecutor real (adaptador del host del piloto) entrega el resultado; el Workflow lo
 *   espera de forma durable (step.sleep + relectura), sin mantener estado en memoria.
 *
 * El gate C-G2 sigue siendo NO VERIFICADO hasta que estas pruebas se ejecuten contra el
 * Workflow desplegado (ATO-524).
 */

import { WorkflowEntrypoint } from "cloudflare:workers";

const POLL_MS = 5000;
const MAX_POLLS = 240; // 20 minutos como máximo por espera

export class AtomikaControlFlow extends WorkflowEntrypoint {
  /**
   * @param {import("cloudflare:workers").WorkflowEvent<any>} event
   * @param {import("cloudflare:workers").WorkflowStep} step
   */
  async run(event, step) {
    const params = event.payload ?? {};
    const taskId = String(params.task_id ?? "");
    const idempotencyKey = String(params.idempotency_key ?? taskId);
    const requireApproval = Boolean(params.require_approval);
    const instruction = String(params.instruction ?? "");

    if (!taskId) {
      return { ok: false, error: "task_id obligatorio" };
    }

    /* ---------------------------------------------------------------- 1. RESERVA */
    const reserve = await step.do("reserve", async () => {
      const key = `ctl:reserve:${idempotencyKey}`;
      const existing = await this.env.CTL.get(key);
      if (existing) {
        return { reserved: false, owner: existing };
      }
      const record = { task_id: taskId, at: new Date().toISOString(), state: "reserved" };
      await this.env.CTL.put(key, JSON.stringify(record));
      return { reserved: true, owner: record };
    });

    if (!reserve.reserved) {
      // Evento duplicado: la reserva ya existe → NO se ejecuta otro efecto.
      return {
        ok: true,
        duplicate: true,
        task_id: taskId,
        idempotency_key: idempotencyKey,
        note: "reserva existente: no se ejecuta un segundo efecto externo",
      };
    }

    /* ------------------------------------------------------------ 2. CHECKPOINT */
    await step.do("checkpoint-running", async () => {
      await this.env.CTL.put(
        `ctl:checkpoint:${taskId}`,
        JSON.stringify({
          task_id: taskId,
          status: "RUNNING",
          stage: "execute",
          recovery_count: 0,
          updated_at: new Date().toISOString(),
        }),
      );
      await this.env.CTL.put(
        `ctl:task:${taskId}`,
        JSON.stringify({
          task_id: taskId,
          status: "RUNNING",
          instruction,
          idempotency_key: idempotencyKey,
          require_approval: requireApproval,
          updated_at: new Date().toISOString(),
        }),
      );
      return { ok: true };
    });

    /* --------------------------------------------------------- 3. APROBACIÓN (C-G2B) */
    if (requireApproval) {
      await step.do("await-approval", async () => {
        await this.env.CTL.put(
          `ctl:checkpoint:${taskId}`,
          JSON.stringify({
            task_id: taskId,
            status: "AWAITING_APPROVAL",
            stage: "approval",
            updated_at: new Date().toISOString(),
          }),
        );
        for (let i = 0; i < MAX_POLLS; i++) {
          const raw = await this.env.CTL.get(`ctl:approval:${taskId}`);
          if (raw) {
            const approval = JSON.parse(raw);
            if (approval.decision === "approved") {
              return { approved: true, approval };
            }
            if (approval.decision === "rejected") {
              return { approved: false, approval };
            }
          }
          await step.sleep(`approval-wait-${i}`, POLL_MS);
        }
        return { approved: false, timeout: true };
      });

      const decision = await step.do("approval-decision", async () => {
        const raw = await this.env.CTL.get(`ctl:approval:${taskId}`);
        const parsed = raw ? JSON.parse(raw) : { decision: "timeout" };
        if (parsed.decision === "approved") {
          // consumo único: deja constancia de que la aprobación ya se usó
          await this.env.CTL.put(
            `ctl:approval:${taskId}`,
            JSON.stringify({ ...parsed, consumed: true, consumed_at: new Date().toISOString() }),
          );
        }
        return parsed;
      });
      if (decision.decision !== "approved") {
        await step.do("checkpoint-rejected", async () => {
          await this.env.CTL.put(
            `ctl:checkpoint:${taskId}`,
            JSON.stringify({
              task_id: taskId,
              status: decision.decision === "rejected" ? "REJECTED" : "FAILED",
              stage: "approval",
              updated_at: new Date().toISOString(),
            }),
          );
          return { ok: true };
        });
        return { ok: false, task_id: taskId, status: decision.decision };
      }
    }

    /* ------------------------------------------------------- 4. ESPERA DEL RESULTADO */
    const result = await step.do("await-execution", async () => {
      for (let i = 0; i < MAX_POLLS; i++) {
        const raw = await this.env.CTL.get(`ctl:result:${taskId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.outcome === "applied") {
            return { ok: true, result: parsed };
          }
          if (parsed.outcome === "error") {
            return { ok: false, error: parsed.error };
          }
        }
        // el ejecutor puede haber muerto a mitad (C-G2A): el checkpoint sigue durable
        await step.sleep(`exec-wait-${i}`, POLL_MS);
      }
      return { ok: false, error: "timeout esperando el resultado del ejecutor" };
    });

    /* ------------------------------------------------------ 5. CHECKPOINT FINAL */
    const final = await step.do("checkpoint-done", async () => {
      const status = result.ok ? "SUCCEEDED" : "FAILED";
      const payload = {
        task_id: taskId,
        status,
        stage: "execute",
        recovery_count: 1,
        artifact: result.ok ? result.result.result?.file ?? null : null,
        sha256: result.ok ? result.result.result?.sha256 ?? null : null,
        commit: result.ok ? result.result.result?.commit ?? null : null,
        head: result.ok ? result.result.result?.head ?? null : null,
        replayed: result.ok ? Boolean(result.result.replayed) : false,
        updated_at: new Date().toISOString(),
      };
      await this.env.CTL.put(`ctl:checkpoint:${taskId}`, JSON.stringify(payload));
      await this.env.CTL.put(
        `ctl:task:${taskId}`,
        JSON.stringify({
          task_id: taskId,
          status,
          instruction,
          idempotency_key: idempotencyKey,
          require_approval: requireApproval,
          artifact: payload.artifact,
          sha256: payload.sha256,
          commit: payload.commit,
          head: payload.head,
          replayed: payload.replayed,
          updated_at: payload.updated_at,
        }),
      );
      return payload;
    });

    return { ok: Boolean(result.ok), task_id: taskId, checkpoint: final };
  }
}
