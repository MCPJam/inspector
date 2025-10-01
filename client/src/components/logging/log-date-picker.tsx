import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface LogDatePickerProps {
  open: boolean;
  setOpen: (value: boolean) => void;
  date: Date;
  setDate: (value: Date) => void;
  onTimeChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDateChange: (value: Date) => void;
}

const LogDatePicker = ({
  open,
  setOpen,
  date,
  onDateChange,
  onTimeChange,
}: LogDatePickerProps) => {
  const extractTime = (date: Date) => {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");

    return `${hours}:${minutes}:${seconds}`;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          id="date-to"
          className="justify-between font-normal"
        >
          {date
            ? date.toLocaleDateString("en-US", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })
            : "Select date"}{" "}
          <ChevronDownIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-2">
        <Calendar
          mode="single"
          required={true}
          selected={date}
          captionLayout="dropdown"
          onSelect={onDateChange}
        />
        <Label className="p-1 flex justify-center w-full">Time</Label>
        <Input
          value={extractTime(date)}
          onChange={onTimeChange}
          type="time"
          id="time-from"
          step="1"
          defaultValue={extractTime(date)}
          className="flex items-center justify-center"
        />
      </PopoverContent>
    </Popover>
  );
};

export default LogDatePicker;
