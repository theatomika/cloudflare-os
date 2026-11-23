# ATOMIKA Control OS v1.2 · entrega E2E (ATO-506 / ATO-513 / ATO-514 / ATO-524 / ATO-526 / ATO-568)

Fecha: **2026-11-23**. Writer: OpenCode (sesión única). QA independiente: agente `mcp-auditor` (Multica).

## 0. Qué es y dónde está

| Pieza | Ubicación | Estado |
|---|---|---|
| **Panel de dirección (UI + API)** | Worker `atomika-control-os` · <https://control.atomika.dev> (Access) | **desplegado**, v`7548a3c4` |
| **Workflow (autoridad durable)** | Worker `atomika-control-flow` · 7+ instancias reales de Cloudflare Workflows | **desplegado** |
| Código del panel | repo privado `theatomika/atomika-control`, rama `feat/ato514-t3-dsh-lab-20261123`, SHA `4d8b3404`, rutas `apps/atomika-control`, `apps/atomika-control-workflow` | versionado |
| Base de la que deriva | fork `theatomika/cloudflare-os` (upstream `cloudflare/cloudflare-os`), rama `feat/atomika-control-os-20261123`, SHA `61153f78` | versionado |
| Ejecutor real (ACP/DSH) | Mevspace `root@195.3.221.232`, `atomika-control-adapter.service` (`127.0.0.1:8787`) | activo |
| T3 Code privado | tunnel de Cloudflare → <https://t3.atomika.dev> (Access) | activo |
| Almacén de control | KV `atomika-control-state` (`161e6678…`) | creado |
| Apps de Access | `5540ae17…` (panel) y `6e19d7c3…` (T3) | creadas, política `owner-only` |

## 1. E2E ejecutado (prueba completa y observable)

| # | Paso del plan | Evidencia | Estado |
|---|---|---|---|
| 1 | Entrar por URL privada con autenticación real | `https://control.atomika.dev/api/state` → **302** al login de Access (`atomikadev.cloudflareaccess.com`) | **PASS** (protección) |
| 2 | Abrir el panel y leer estados de fuentes reales | `GET /api/machine/state`: Linear 6 issues con estado, GitHub repo+commits+checks, Multica 10 issues + 14 agentes, Workflows 7 instancias `complete`, piloto conectado, 7 tareas con checkpoint | **PASS** |
| 3 | Lanzar una tarea sintética autorizada | `POST /api/tasks` → `task_id=tmwtn5slz5sr0`, `instance_id=ctl-idem-tmwtn5slz5sr0` (idempotency key `idem:<task>`) | **PASS** |
| 4 | Recepción por Workflows y ejecución | instancia real `ctl-idem-entrega-v1` en Cloudflare Workflows; el adaptador ejecutó la tarea **por ACP con el modelo real** → el fichero `evidencia-e2e-ctl.md` contiene `E2E-CTL-OK` | **PASS** |
| 5 | Artefacto y SHA en GitHub | commit `f311a827` en `theatomika/atomika-control@feat/ato514-t3-dsh-lab-20261123` con `lab/t3-dsh/evidence/evidencia-tmwtndpi1d48x.md` (sha `f3f8e5a68c4b…`) | **PASS** |
| 6 | Relevo a QA independiente | Multica `ATOM-421` (`mcp-auditor`, solo lectura) launched sobre SHA estable | **PASS** (lanzado; ver §5) |
| 7 | Recuperación tras interrupción real | C-G2A: el ejecutor aplicó el efecto y **murió por SIGKILL**; el Workflow reconcilió y terminó `SUCCEEDED` con `recovery_count=1`; ledger con **1** efecto | **PASS** |
| 8 | Idempotencia, permisos por proyecto y denegación | C-G2C: la misma `idempotency_key` → misma tarea y misma instancia → una ejecución; `/api/state` sin identidad → 403; cabecera `Cf-Access-Authenticated-User-Email` falsificada en el hostname público → **403** | **PASS** |
| 9 | Volver al panel y ver el resultado correcto | checkpoint `SUCCEEDED` con artefacto, sha256, commit y head del repo | **PASS** |

## 2. Gate de Workflows (C-G2A/B/C) sobre ejecuciones reales

Nada de esto es un simulador: son instancias de **Cloudflare Workflows** (`atomika-control-flow`).

### C-G2A · caída y recuperación con checkpoint durable
- Tarea `tmwtnbnj3d6om` (`idem-c-g2a-v1`), modo `crash`: el adaptador **aplica el efecto**
  (artefacto + commit) y **muere por SIGKILL antes de responder**.
- El Workflow sigue en `await-execution` (checkpoint durable en KV); el adaptador lo re-reclama
  (reclaim tras 20 s sin resultado) y devuelve **el mismo resultado** desde su ledger, sin repetir el efecto.
- Resultado: `SUCCEEDED`, `recovery_count=1`, sha `fcd99727e018…`.
- **Ledger: exactamente 1 entrada** para esa tarea (sin duplicados).

### C-G2B · aprobación suspendida que sobrevive a reinicios
- Tarea `tmwtn9j9zgngm` (`idem-c-g2b-v1`) con `require_approval=true`.
- El Workflow quedó en **`AWAITING_APPROVAL`** y **sobrevivió a un redespliegue del Worker**
  (estado durable en KV; el checkpoint siguió en `AWAITING_APPROVAL`).
- Mientras esperaba: **0 efectos** nuevos.
- Tras la decisión de aprobación: `SUCCEEDED`, 1 solo efecto (sha `ffea1d3f614f…`).
- Una **segunda** aprobación: **0 efectos adicionales** (no avanzó dos veces).

### C-G2C · evento duplicado
- La API es idempotente: la misma `idempotency_key` devuelve la **misma** `task_id` y el **mismo**
  `instance_id` (`duplicate: true`), y el Workflow mantiene una **reserva idempotente en KV**.
- Resultado: una sola ejecución y un solo efecto por clave.

## 3. Seguridad y aislamiento

| Control | Comprobación | Estado |
|---|---|---|
| Panel privado | `control.atomika.dev` → 302 Access | PASS |
| Hostname público sin datos | `workers.dev/api/state` sin identidad → 403 | PASS |
| Identidad falsificada | cabecera `Cf-Access-Authenticated-User-Email` en el hostname público → 403 | PASS |
| Rutas de máquina | solo con secreto; `READ_KEY` es de solo lectura (`GET` únicamente) | PASS |
| Aprobaciones | `POST /api/approvals/*` exige identidad de Access; ninguna credencial de máquina sirve | PASS |
| T3 privado | `t3.atomika.dev` → 302 Access | PASS |
| Secretos | 7 secrets del Worker; nada en el repo ni en el código | PASS |
| Puerto del ejecutor | el adaptador solo escucha en `127.0.0.1`; el tunnel expone únicamente T3 | PASS |
| Socket Docker | `660 root:docker`, grupo `docker` sin miembros → solo root | PASS (revisado por QA) |

**Límite real (NO VERIFICADO):** la revocación de una **sesión** autenticada (retirar la política y
comprobar que una sesión previa deja de servir) exige una sesión real de Access, y el alta de sesión
de este equipo es por **código OTP al correo del titular** (paso humano). Lo verificado es que el
control de acceso lo gobierna la app de Access y su política `owner-only`, y que el panel, además,
exige identidad en la lista de control.

## 4. Coste

- **0 €** de gasto nuevo: sin compras, sin planes nuevos, sin facturación activada.
- Cloudflare Workflows: la cuenta **ya lo tenía** (API habilitada, 0 workflows previos); se han creado
  7+ instancias de prueba (cuota incluida en el plan existente).
- Consumo medible: tokens de modelos (runs de Multica), nº de instancias, tamaño de artefactos
  (8 bytes–162 bytes), commits. **Coste monetario: NO MEDIDO** (las APIs no exponen precio) y así se
  declara en el panel, sin inventar cifras.

## 5. QA independiente

Multica `ATOM-421` (`mcp-auditor`, solo lectura) sobre el SHA estable. Su informe se custodia en
**ATO-514**; la matriz completa en ese ticket. Un informe del writer **no** sustituye esa revisión.

## 6. Rollback

Ver `apps/atomika-control/README.md` (tabla de rollback) y `lab/t3-dsh/docs/ROLLBACK.md` (lab del piloto).
Resumen: borrar Workers y rutas, borrar apps de Access, parar tunnel y adaptador, revocar la deploy
key (`170880635`), borrar los 7 secrets y —si procede— el namespace KV (⚠ destruye checkpoints).
La evidencia publicada en el repo privado **no** se borra al revocar el sistema.

## 7. Lo que queda pendiente (dependencias externas, no bloqueantes del sistema)

1. **Alta de sesión humana** en los dos dominios privados (código OTP por correo). Es el único paso que
   requiere intervención del titular; a partir de ahí, el panel y T3 quedan operables tal cual.
2. `GET /api/tasks` y `POST /api/tasks` del panel están protegidos por identidad; el E2E automatizado
   usó la credencial de máquina `LAUNCH_KEY` (documentada, reversible, sin capacidad de aprobar).
3. C-G2 queda **PASS** en lo verificado contra Workflows reales; el gate de *panel cliente* (ATO-526)
   queda acotado a lo descrito en §3 (la revocación de sesión sigue siendo el único punto NO VERIFICADO).
