import { Button } from "@/components/ui/button";

const PingTab = ({ onPingClick }: { onPingClick: () => void }) => {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="col-span-2 flex justify-center items-center">
        <Button
          onClick={onPingClick}
          className="font-bold py-6 px-12 rounded-full"
        >
          Ping Server
        </Button>
      </div>
    </div>
  );
};

export default PingTab;
