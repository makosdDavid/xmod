import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  // the game's buttons (helper.lua:3227-3229, widget_fullscreen.lua:15570-15660): button_background_default
  // #003c66 with a 1 px button_border_default line (config.button.border = 1, :580/:8708); mouse-over = the
  // highlight colour (see --x4-button-hover), pressed = button_background_inactive #202020; inactive =
  // #202020 / border #303030 / text #808080. Pressed toggle / open menu = row_background_selected (x4-on).
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:border-(--x4-button-inactive-border) disabled:bg-(--x4-button-inactive) disabled:text-(--x4-text-off) aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:x4-on data-[state=open]:x4-on [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-input bg-(--x4-button-bg) text-foreground hover:bg-(--x4-button-hover) active:bg-(--x4-button-pressed)",
        destructive:
          "border-destructive/70 bg-(--x4-danger-bg) text-white hover:border-destructive active:bg-(--x4-button-pressed) focus-visible:ring-destructive/40",
        outline:
          "border-input bg-(--x4-button-bg) text-foreground hover:bg-(--x4-button-hover) active:bg-(--x4-button-pressed)",
        secondary:
          "border-input bg-(--x4-button-bg) text-foreground hover:bg-(--x4-button-hover) active:bg-(--x4-button-pressed)",
        ghost:
          "hover:bg-(--x4-button-hover) hover:text-foreground active:bg-(--x4-button-pressed) disabled:border-transparent disabled:bg-transparent",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
