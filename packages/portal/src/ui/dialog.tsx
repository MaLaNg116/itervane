// Adapted from the shadcn/ui Base UI registry. See public/shadcn-LICENSE.txt.
import type { ComponentProps } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { cn } from './cn.js';

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: Omit<DialogPrimitive.Popup.Props, 'className'> & { className?: string }) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Backdrop data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-foreground/45" />
    <DialogPrimitive.Popup
      data-slot="dialog-content"
      className={cn('fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-xl border border-solid border-border bg-card p-5 text-sm text-foreground shadow-xl sm:p-6', className)}
      {...props}
    >
      {children}
    </DialogPrimitive.Popup>
  </DialogPrimitive.Portal>;
}

export function DialogTitle({ className, ...props }: Omit<DialogPrimitive.Title.Props, 'className'> & { className?: string }) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('mt-0 mb-3 text-xl font-semibold', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: Omit<DialogPrimitive.Description.Props, 'className'> & { className?: string }) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('m-0 text-muted-foreground', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('mt-5 flex flex-wrap justify-end gap-2', className)} {...props} />;
}
