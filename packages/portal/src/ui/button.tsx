// Adapted from the shadcn/ui Base UI registry. See public/shadcn-LICENSE.txt.
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn.js';

export const buttonVariants = cva(
  'inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-solid px-4 py-2 text-center text-sm font-semibold leading-snug transition-colors disabled:cursor-not-allowed disabled:opacity-60',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border-border bg-card text-foreground hover:bg-muted',
        destructive: 'border-destructive/35 bg-card text-destructive hover:bg-destructive/8',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Button({ className, variant = 'default', ...props }: Omit<ButtonPrimitive.Props, 'className'> & VariantProps<typeof buttonVariants> & { className?: string }) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant }), className)} {...props} />;
}
