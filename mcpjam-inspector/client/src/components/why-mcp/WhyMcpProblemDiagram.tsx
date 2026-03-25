import { memo } from "react";
import { motion } from "framer-motion";
import { Brain, Database, Cloud, FileText, Wrench } from "lucide-react";

const EASE = [0.25, 0.1, 0.25, 1] as const;

/** External system icon — dimmed with gentle floating animation. */
function GhostSystem({
  icon: Icon,
  label,
  bobDelay,
  enterDelay,
}: {
  icon: React.ElementType;
  label: string;
  bobDelay: number;
  enterDelay: number;
}) {
  return (
    <motion.div
      className="flex flex-col items-center gap-1.5"
      initial={{ opacity: 0, scale: 0.8 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{ delay: enterDelay, duration: 0.5, ease: EASE }}
    >
      <motion.div
        className="w-11 h-11 rounded-lg border border-dashed border-muted-foreground/20 flex items-center justify-center"
        animate={{ y: [0, -3, 0] }}
        transition={{
          duration: 4,
          delay: bobDelay,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      >
        <Icon className="w-4 h-4 text-muted-foreground/40" />
      </motion.div>
      <span className="text-[9px] text-muted-foreground/40 font-medium">
        {label}
      </span>
    </motion.div>
  );
}

/** Animated dashed line that travels outward and fades — a signal that dies. */
function FadingSignal({ delay, flip }: { delay: number; flip?: boolean }) {
  return (
    <div
      className="flex-1 flex items-center justify-center overflow-hidden"
      style={{ transform: flip ? "scaleX(-1)" : undefined }}
    >
      <motion.div
        className="h-px w-full"
        style={{
          background:
            "linear-gradient(to right, rgba(139,92,246,0.4), rgba(139,92,246,0.08) 60%, transparent)",
        }}
        animate={{ opacity: [0, 0.8, 0] }}
        transition={{
          duration: 2.5,
          delay,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
    </div>
  );
}

export const WhyMcpProblemDiagram = memo(function WhyMcpProblemDiagram() {
  return (
    <div className="relative rounded-lg border border-border/50 overflow-hidden">
      {/* Subtle radial background */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-purple-500/[0.04] via-transparent to-transparent" />

      <div className="relative flex items-center justify-center gap-3 px-6 py-10">
        {/* Left systems */}
        <motion.div
          className="flex flex-col gap-4"
          initial={{ opacity: 0, x: -12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4, duration: 0.5 }}
        >
          <GhostSystem
            icon={Database}
            label="Database"
            bobDelay={0}
            enterDelay={0.5}
          />
          <GhostSystem
            icon={Cloud}
            label="APIs"
            bobDelay={0.7}
            enterDelay={0.7}
          />
        </motion.div>

        {/* Left fading signal */}
        <FadingSignal delay={0.8} flip />

        {/* Center: LLM node with pulsing ring */}
        <motion.div
          className="relative z-10 shrink-0"
          initial={{ opacity: 0, scale: 0.85 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          {/* Subtle pulse ring */}
          <motion.div
            className="absolute -inset-4 rounded-2xl border border-purple-400/15"
            animate={{ scale: [1, 1.15, 1], opacity: [0.6, 0.2, 0.6] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />

          {/* Breathing glow */}
          <motion.div
            className="absolute -inset-3 rounded-2xl bg-purple-500/10 blur-lg"
            animate={{ opacity: [0.2, 0.5, 0.2] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />

          <div className="relative flex flex-col items-center justify-center w-[76px] h-[76px] rounded-xl border-2 border-purple-400/30 bg-card shadow-sm">
            <Brain className="w-6 h-6 text-purple-400/80" />
            <span className="text-[10px] text-purple-400/60 font-semibold mt-0.5">
              LLM
            </span>
          </div>

          {/* "text in · text out" below */}
          <motion.div
            className="absolute -bottom-7 left-1/2 -translate-x-1/2 whitespace-nowrap"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.6 }}
          >
            <span className="text-[9px] text-purple-400/40 font-mono tracking-wider">
              text in · text out
            </span>
          </motion.div>
        </motion.div>

        {/* Right fading signal */}
        <FadingSignal delay={1.6} />

        {/* Right systems */}
        <motion.div
          className="flex flex-col gap-4"
          initial={{ opacity: 0, x: 12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4, duration: 0.5 }}
        >
          <GhostSystem
            icon={FileText}
            label="Files"
            bobDelay={0.3}
            enterDelay={0.9}
          />
          <GhostSystem
            icon={Wrench}
            label="Services"
            bobDelay={1.0}
            enterDelay={1.1}
          />
        </motion.div>
      </div>
    </div>
  );
});
