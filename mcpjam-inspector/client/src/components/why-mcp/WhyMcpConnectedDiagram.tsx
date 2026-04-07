import { memo } from "react";
import { motion } from "framer-motion";
import { Brain, Database, Cloud, FileText, Wrench } from "lucide-react";
import {
  springGentle,
  springSnappy,
  useDiagramMotion,
  VIEWPORT_ONCE,
} from "./diagram-motion";

const bundleVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.09, delayChildren: 0.06 },
  },
};

const sideVariants = {
  hidden: { opacity: 0, x: -14 },
  show: { opacity: 1, x: 0, transition: springGentle },
};

const sideRightVariants = {
  hidden: { opacity: 0, x: 14 },
  show: { opacity: 1, x: 0, transition: springGentle },
};

const centerVariants = {
  hidden: { opacity: 0, scale: 0.88 },
  show: { opacity: 1, scale: 1, transition: springGentle },
};

const wireVariants = {
  hidden: { opacity: 0, scaleX: 0.85 },
  show: { opacity: 1, scaleX: 1, transition: springGentle },
};

function SystemTile({
  icon: Icon,
  label,
  delay,
}: {
  icon: React.ElementType;
  label: string;
  delay: number;
}) {
  const { reduce } = useDiagramMotion();
  return (
    <motion.div
      className="flex flex-col items-center gap-1.5"
      variants={{
        hidden: { opacity: 0, scale: 0.92 },
        show: { opacity: 1, scale: 1, transition: { ...springGentle, delay } },
      }}
    >
      <motion.div
        className="flex h-11 w-11 items-center justify-center rounded-xl border border-blue-300/55 bg-gradient-to-b from-card to-blue-50/40 shadow-sm dark:border-blue-600/40 dark:from-card dark:to-blue-950/30"
        animate={reduce ? {} : { y: [0, -3, 0] }}
        transition={
          reduce
            ? { duration: 0 }
            : {
                duration: 3.6,
                repeat: Infinity,
                ease: "easeInOut",
                delay: delay * 2,
              }
        }
        whileHover={{ scale: 1.05, transition: springSnappy }}
        whileTap={{ scale: 0.97, transition: springSnappy }}
      >
        <Icon className="h-4 w-4 text-blue-600 dark:text-blue-400/95" />
      </motion.div>
      <span className="text-[9px] font-medium text-muted-foreground">
        {label}
      </span>
    </motion.div>
  );
}

function LiveWire({ flip, delay }: { flip?: boolean; delay: number }) {
  const { reduce } = useDiagramMotion();
  return (
    <div
      className="flex flex-1 items-center justify-center self-center overflow-visible px-0.5"
      style={{ transform: flip ? "scaleX(-1)" : undefined }}
    >
      <div className="relative h-1 w-full max-w-[4rem] overflow-hidden rounded-full bg-blue-500/15 dark:bg-blue-400/20 sm:max-w-[5rem]">
        <motion.div
          className="absolute inset-y-0 w-[40%] rounded-full bg-gradient-to-r from-transparent via-blue-500 to-transparent dark:via-blue-400"
          aria-hidden
          animate={reduce ? { x: "30%" } : { x: ["-40%", "120%"] }}
          transition={
            reduce
              ? { duration: 0 }
              : {
                  duration: 1.8,
                  repeat: Infinity,
                  ease: "linear",
                  repeatDelay: 0.5,
                  delay,
                }
          }
        />
      </div>
    </div>
  );
}

export const WhyMcpConnectedDiagram = memo(function WhyMcpConnectedDiagram() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-blue-200/45 bg-gradient-to-b from-blue-50/80 to-card shadow-sm dark:border-blue-900/40 dark:from-blue-950/25 dark:to-card">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.1),transparent_65%)] dark:bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.16),transparent_65%)]" />

      <motion.div
        className="relative flex items-center justify-center gap-2 px-5 py-10 sm:gap-4 sm:px-10"
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT_ONCE}
        variants={bundleVariants}
      >
        <motion.div className="flex flex-col gap-4" variants={sideVariants}>
          <SystemTile icon={Database} label="Database" delay={0.02} />
          <SystemTile icon={Cloud} label="APIs" delay={0.12} />
        </motion.div>

        <motion.div
          className="flex min-w-0 flex-1 justify-center"
          variants={wireVariants}
        >
          <LiveWire delay={0} flip />
        </motion.div>

        <motion.div
          className="relative z-10 shrink-0"
          variants={centerVariants}
        >
          <motion.div
            className="absolute -inset-4 rounded-2xl border border-blue-400/30"
            animate={{ scale: [1, 1.1, 1], opacity: [0.5, 0.2, 0.5] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="absolute -inset-3 rounded-2xl bg-blue-500/15 blur-xl dark:bg-blue-400/20"
            animate={{ opacity: [0.25, 0.5, 0.25] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="relative flex h-[4.75rem] w-[4.75rem] flex-col items-center justify-center rounded-2xl border-2 border-blue-400/50 bg-card shadow-lg dark:border-blue-500/45"
            whileHover={{ y: -2, transition: springSnappy }}
          >
            <Brain className="h-7 w-7 text-blue-600 dark:text-blue-400" />
            <span className="mt-0.5 text-[10px] font-bold tracking-tight text-blue-700 dark:text-blue-300">
              LLM
            </span>
          </motion.div>
          <motion.div
            className="absolute -bottom-8 left-1/2 w-max -translate-x-1/2"
            initial={{ opacity: 0, y: 4 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={VIEWPORT_ONCE}
            transition={{ ...springGentle, delay: 0.25 }}
          >
            <span className="text-[9px] font-mono tracking-wider text-blue-600/70 dark:text-blue-400/60">
              connected via MCP
            </span>
          </motion.div>
        </motion.div>

        <motion.div
          className="flex min-w-0 flex-1 justify-center"
          variants={wireVariants}
        >
          <LiveWire delay={0.35} />
        </motion.div>

        <motion.div
          className="flex flex-col gap-4"
          variants={sideRightVariants}
        >
          <SystemTile icon={FileText} label="Files" delay={0.08} />
          <SystemTile icon={Wrench} label="Services" delay={0.18} />
        </motion.div>
      </motion.div>
    </div>
  );
});
