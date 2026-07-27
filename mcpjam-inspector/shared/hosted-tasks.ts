/**
 * Hosted tasks constants shared by the server routes and the client poller.
 *
 * Hosted tasks are polled with a reconnect per tick (authorize → connect →
 * `tasks/get-batch` → disconnect), so these two numbers are the cost control:
 * the batch cap bounds one tick to a single connection per server, and the
 * poll floor bounds how often a tick can happen. They live in `shared/` so the
 * client cannot drift from what the route enforces.
 */

/** One connection per server per TasksTab tick — the main hosted cost control. */
export const HOSTED_TASK_BATCH_MAX = 50;

/**
 * Lower bound (ms) for hosted polling, under the user-configurable interval
 * and under any server-suggested `pollIntervalMs`. Not configurable by env.
 */
export const HOSTED_TASK_POLL_FLOOR_MS = 2000;
