import { memo } from "react";
import { motion } from "framer-motion";
import {
  Bot,
  Database,
  FileText,
  GitBranch,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { useDiagramMotion, VIEWPORT_ONCE } from "./diagram-motion";

const EASE = [0.25, 0.1, 0.25, 1] as const;

const tools = [
  { icon: Database, label: "DB" },
  { icon: MessageSquare, label: "Chat" },
  { icon: GitBranch, label: "Git" },
  { icon: FileText, label: "Files" },
] as const;

/** Agent proposes — same weight as peripheral nodes in the problem diagram, slightly warmer. */
function AgentNode({
  reduce,
  bobDelay,
  enterDelay,
}: {
  reduce: boolean;
  bobDelay: number;
  enterDelay: number;
}) {
  return (
    <motion.div
      className="flex flex-col items-center gap-1.5"
      initial={{ opacity: 0, scale: 0.8 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={VIEWPORT_ONCE}
      transition={{ delay: enterDelay, duration: 0.5, ease: EASE }}
    >
      <motion.div
        className="flex h-11 w-11 items-center justify-center rounded-lg border border-dashed border-amber-600/25 dark:border-amber-500/30"
        animate={reduce ? undefined : { y: [0, -3, 0] }}
        transition={
          reduce
            ? undefined
            : {
                duration: 4,
                delay: bobDelay,
                repeat: Infinity,
                ease: "easeInOut",
              }
        }
      >
        <Bot className="h-4 w-4 text-amber-700/50 dark:text-amber-400/55" />
      </motion.div>
      <span className="text-[9px] font-medium text-amber-900/55 dark:text-amber-200/55">
        Agent
      </span>
    </motion.div>
  );
}

/** Reachable tools — solid tiles, gentle bob (connected state vs. the problem diagram’s ghosts). */
function ConnectedTool({
  icon: Icon,
  label,
  bobDelay,
  enterDelay,
  reduce,
}: {
  icon: (typeof tools)[number]["icon"];
  label: string;
  bobDelay: number;
  enterDelay: number;
  reduce: boolean;
}) {
  return (
    <motion.div
      className="flex flex-col items-center gap-1.5"
      initial={{ opacity: 0, scale: 0.8 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={VIEWPORT_ONCE}
      transition={{ delay: enterDelay, duration: 0.5, ease: EASE }}
    >
      <motion.div
        className="flex h-11 w-11 items-center justify-center rounded-lg border border-amber-300/40 bg-card/80 shadow-sm dark:border-amber-600/35"
        animate={reduce ? undefined : { y: [0, -3, 0] }}
        transition={
          reduce
            ? undefined
            : {
                duration: 4,
                delay: bobDelay,
                repeat: Infinity,
                ease: "easeInOut",
              }
        }
      >
        <Icon className="h-4 w-4 text-amber-800/70 dark:text-amber-300/75" />
      </motion.div>
      <span className="text-[9px] font-medium text-amber-900/65 dark:text-amber-200/70">
        {label}
      </span>
    </motion.div>
  );
}

/** Pulse that travels along the bar — permission flowing through the gate. */
function FlowPulse({ delay, reduce }: { delay: number; reduce: boolean }) {
  return (
    <div className="flex min-w-[1.5rem] max-w-[3rem] flex-1 items-center justify-center overflow-hidden sm:max-w-none">
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-amber-500/12 dark:bg-amber-400/10">
        {reduce ? null : (
          <motion.div
            className="absolute inset-y-0 w-[45%] rounded-full"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(245, 158, 11, 0.85), transparent)",
            }}
            animate={{ left: ["-45%", "120%"] }}
            transition={{
              duration: 2.4,
              delay,
              repeat: Infinity,
              ease: "linear",
            }}
          />
        )}
      </div>
    </div>
  );
}

export const WhyMcpGovernanceDiagram = memo(function WhyMcpGovernanceDiagram() {
  const { reduce } = useDiagramMotion();

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-border/50"
      role="group"
      aria-label="Governance flow from agent through policy to tools"
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-amber-500/[0.06] via-transparent to-transparent dark:from-amber-500/[0.09]" />

      <div className="relative flex items-center justify-center gap-2 px-5 py-10 sm:gap-3 sm:px-6">
        <motion.div
          className="flex shrink-0 flex-col gap-4"
          initial={{ opacity: 0, x: -12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={VIEWPORT_ONCE}
          transition={{ delay: 0.35, duration: 0.5 }}
        >
          <AgentNode reduce={reduce} bobDelay={0} enterDelay={0.45} />
        </motion.div>

        <FlowPulse delay={0.7} reduce={reduce} />

        {/* Center — policy as the live gate (mirrors the LLM node in the problem diagram). */}
        <motion.div
          className="relative z-10 flex shrink-0 flex-col items-center"
          initial={{ opacity: 0, scale: 0.85 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={VIEWPORT_ONCE}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <div className="relative">
            <motion.div
              className="absolute -inset-4 rounded-2xl border border-amber-500/20 dark:border-amber-400/15"
              animate={
                reduce
                  ? undefined
                  : { scale: [1, 1.12, 1], opacity: [0.55, 0.18, 0.55] }
              }
              transition={
                reduce
                  ? undefined
                  : { duration: 3, repeat: Infinity, ease: "easeInOut" }
              }
            />

            <motion.div
              className="absolute -inset-3 rounded-2xl bg-amber-500/10 blur-lg dark:bg-amber-500/15"
              animate={reduce ? undefined : { opacity: [0.18, 0.42, 0.18] }}
              transition={
                reduce
                  ? undefined
                  : { duration: 3, repeat: Infinity, ease: "easeInOut" }
              }
            />

            <div className="relative flex h-[76px] w-[76px] flex-col items-center justify-center rounded-xl border-2 border-amber-500/35 bg-card shadow-sm dark:border-amber-500/40">
              <ShieldCheck className="h-6 w-6 text-amber-600/85 dark:text-amber-400/85" />
              <span className="mt-0.5 text-[10px] font-semibold text-amber-700/80 dark:text-amber-300/80">
                Policy
              </span>
            </div>
          </div>

          <motion.div
            className="mt-4"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={VIEWPORT_ONCE}
            transition={{ delay: 0.55 }}
          >
            <span className="whitespace-nowrap text-[9px] font-mono leading-normal tracking-wider text-amber-700/40 dark:text-amber-400/40">
              allow · audit · revoke
            </span>
          </motion.div>
        </motion.div>

        <FlowPulse delay={1.2} reduce={reduce} />

        <motion.div
          className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-4"
          initial={{ opacity: 0, x: 12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={VIEWPORT_ONCE}
          transition={{ delay: 0.35, duration: 0.5 }}
          aria-label="Tools and data"
        >
          {tools.map(({ icon, label }, i) => (
            <ConnectedTool
              key={label}
              icon={icon}
              label={label}
              bobDelay={i * 0.22}
              enterDelay={0.55 + i * 0.12}
              reduce={reduce}
            />
          ))}
        </motion.div>
      </div>
    </div>
  );
});
