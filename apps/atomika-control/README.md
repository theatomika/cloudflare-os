# ATOMIKA Control OS · panel de dirección (Worker)

Interfaz única de dirección del proyecto, construida sobre la base de **Cloudflare OS**
(fork `theatomika/cloudflare-os`, upstream `cloudflare/cloudflare-os`).

- **URL principal (privada, con Cloudflare Access):** `https://control.atomika.dev`
- Ruta de máquina (sin Access, solo con el secreto `ADAPTER_KEY`/`READ_KEY`):
  `https://atomika-control-os.thehub-271.workers.dev/api/machine/*`
- **Workflow (autoridad durable):** Worker `atomika-control-flow` (instancias reales de Cloudflare Workflows).

## Qué muestra y de dónde sale cada dato

| Bloque del panel | Fuente real | Cómo se lee |
|---|---|---|
| Gates y decisiones | Linear (API GraphQL) | issues ATO-506/513/514/524/526/568 + su último comentario |
| Código y SHA | GitHub (API REST) | repo privado `theatomika/atomika-control`, rama del lab, commits, PRs y checks |
| Agentes y runs | Multica (`/api/issues`, `/api/agents`) | workspace `atomika` |
| Workflows y checkpoints | Cloudflare API | instancias de `atomika-control-flow` + checkpoints en KV |
| T3 / DeepSeek Harness | host del piloto (`atomika-control-adapter.service`) | hilos de T3, sesiones DSH, sha de la evidencia, ledger de efectos |
| T3 Code privado | tunnel de Cloudflare | `https://t3.atomika.dev` (Access) |
| Coste | — | **NO MEDIDO**: las APIs disponibles exponen tokens, no precio. Se declaran las magnitudes medidas (tokens, instancias, bytes) |

Nada de lo que se presenta como operativo es de maqueta: cada bloque es una lectura de la fuente
correspondiente, con `fetched_at` en la respuesta.

## Modelo de ejecución

```
UI (control.atomika.dev, Access)
  └─ POST /api/tasks  →  crea la tarea en KV + instancia del Workflow (id determinista por idempotency_key)
                          └─ Workflow (autoridad durable)
                               ├─ reserva idempotente en KV   (una clave ⇒ una ejecución)
                               ├─ checkpoint RUNNING en KV
                               ├─ espera de aprobación (si la tarea la requiere)  ← AWAITING_APPROVAL
                               └─ espera del resultado del ejecutor
                                    ▲
adaptador (Mevspace, 127.0.0.1:8787) ─┘  hace pull de /api/machine/poll cada 5 s
  ├─ ejecuta la tarea real por ACP (DeepSeek Harness) → fichero + sha256
  ├─ versiona el artefacto en el repo privado (deploy key) → commit + push
  └─ registra el efecto en un ledger append-only (una entrada por tarea)
```

El **adaptador tira** del panel en vez de que el panel lo llame: así el host no necesita exponer
ningún puerto hacia Internet y el Workflow (que vive en Cloudflare) tampoco necesita una ruta de
entrada al host.

## Reglas de seguridad

- Toda ruta de **dirección** (`/api/state`, `/api/tasks`, `/api/approvals/*`) exige identidad de
  **Cloudflare Access** y que el email esté en la lista de control (`CONTROL_EMAILS`).
- La identidad **solo** se acepta en el hostname protegido por Access (`control.atomika.dev`). En
  `workers.dev` las cabeceras `Cf-Access-*` son falsificables: ahí la API responde 403 y la única
  vía es el secreto de máquina.
- Las **aprobaciones** humanas exigen identidad de Access. Las credenciales de máquina (`ADAPTER_KEY`,
  `READ_KEY`, `LAUNCH_KEY`) **no** pueden aprobar: `READ_KEY` es de solo lectura y `POST /api/approvals/*`
  no acepta ninguna de ellas.
- Los secretos viven como *secrets* del Worker, nunca en el repo ni en el código.

## Despliegue

```bash
export CLOUDFLARE_API_TOKEN=...      # token de la API de Cloudflare
export CLOUDFLARE_ACCOUNT_ID=2714b0cae2ff68804b31db1986e7419b
pnpm exec wrangler deploy --config apps/atomika-control-workflow/wrangler.jsonc   # Workflow
pnpm exec wrangler deploy --config apps/atomika-control/wrangler.jsonc            # panel
```

Secretos del panel: `LINEAR_API_KEY`, `GITHUB_TOKEN`, `MULTICA_TOKEN`, `CLOUDFLARE_API_TOKEN`,
`ADAPTER_KEY`, `READ_KEY`, `LAUNCH_KEY` (todos con `wrangler secret put`, nunca en argv).

## Rollback

Todo es reversible y está acotado:

| Qué | Cómo se revierte |
|---|---|
| Panel | `wrangler delete --config apps/atomika-control/wrangler.jsonc` (y `.../atomika-control-workflow/…`) |
| Dominio | `wrangler deploy` con `routes: []` y volver a borrar el registro DNS `control.atomika.dev` |
| Acceso | borrar la app de Access `ATOMIKA Control OS · panel de dirección` (id `5540ae17-…`) y la de T3 (`6e19d7c3-…`) |
| Tunnel | `systemctl disable --now atomika-tunnel.service` + borrar el registro CNAME `t3.atomika.dev` |
| Adaptador | `systemctl disable --now atomika-control-adapter.service` + borrar `/root/pilot-adapter` |
| Deploy key | `gh api -X DELETE repos/theatomika/atomika-control/keys/170880635` y borrar `/root/.ssh/atomika_control` |
| Secretos | `wrangler secret delete <NAME> --config …` (los 7) |
| KV de control | borrar el namespace `atomika-control-state` (`161e6678…`) — **destruye checkpoints**; exportar antes si hay que conservarlos |
| Evidencia | los artefactos viven en el repo privado (`lab/t3-dsh/evidence/`): no se borran al revocar el sistema |

Verificación post-rollback: `docker ps -a --filter ancestor=dsh-pilot:0.2.2-rc.5` vacío ·
`curl https://control.atomika.dev/` → 302 a Access · `curl https://t3.atomika.dev/` → 302 a Access ·
`gh api repos/theatomika/atomika-control/commits?sha=feat/ato514-t3-dsh-lab-20261123` sigue listando
la evidencia.
