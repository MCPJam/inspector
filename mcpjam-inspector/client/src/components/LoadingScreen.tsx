export default function LoadingScreen({
  overlay = false,
  testId = "loading-screen",
}: {
  overlay?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={
        overlay
          ? "fixed inset-0 z-[90] flex items-center justify-center bg-background"
          : "min-h-screen bg-background flex items-center justify-center"
      }
      data-testid={testId}
    >
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-gray-200 border-t-primary mx-auto"></div>
      </div>
    </div>
  );
}
