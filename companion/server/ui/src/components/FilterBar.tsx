// Filter choice that adapts to the panel width (U7): a wrapping toggle group when there is room,
// a compact select when the panel is narrow (container query on the panel body).
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface FilterOpt { value: string; label: string; tip?: string; badge?: number; alert?: boolean }

export function FilterBar({ value, onChange, options, wideAt = "30rem", label, className }: {
  value: string; onChange: (v: string) => void; options: FilterOpt[]; wideAt?: "24rem" | "30rem" | "36rem" | "44rem" | "52rem" | "72rem"; label: string; className?: string;
}) {
  const wide = { "24rem": "@[24rem]:flex", "30rem": "@[30rem]:flex", "36rem": "@[36rem]:flex", "44rem": "@[44rem]:flex", "52rem": "@[52rem]:flex", "72rem": "@[72rem]:flex" }[wideAt];
  const narrow = { "24rem": "@[24rem]:hidden", "30rem": "@[30rem]:hidden", "36rem": "@[36rem]:hidden", "44rem": "@[44rem]:hidden", "52rem": "@[52rem]:hidden", "72rem": "@[72rem]:hidden" }[wideAt];
  const badge = (o: FilterOpt) => o.badge ? (
    <Badge variant={o.alert ? "destructive" : "default"} className={cn("ml-1 h-4 min-w-4 px-1 text-[0.65rem] tabular-nums", o.alert && "animate-pulse")}>
      {o.badge >= 99 ? "99+" : o.badge}
    </Badge>
  ) : null;
  return (
    <div className={cn("min-w-0", className)}>
      <ToggleGroup type="single" spacing={1} value={value} onValueChange={(v) => v && onChange(v)} aria-label={label}
        className={cn("hidden flex-wrap justify-start gap-1", wide)}>
        {options.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value} title={o.tip} size="sm"
            className="h-7 flex-none rounded-full border border-border/60 px-2.5 text-xs data-[state=on]:border-primary/60 data-[state=on]:bg-primary/15 data-[state=on]:text-foreground">
            {o.label}{badge(o)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className={cn("flex", narrow)}>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger size="sm" className="h-7 w-full min-w-0 text-xs" aria-label={label} title={label}><SelectValue /></SelectTrigger>
          <SelectContent>
            {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}{badge(o)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
