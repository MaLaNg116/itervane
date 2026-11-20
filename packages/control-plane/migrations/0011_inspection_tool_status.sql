ALTER TABLE "itervane"."tool_calls" DROP CONSTRAINT "tool_call_status";--> statement-breakpoint
ALTER TABLE "itervane"."tool_calls" ADD CONSTRAINT "tool_call_status" CHECK (
  "itervane"."tool_calls"."status" IN ('reserved', 'success', 'business_error', 'infrastructure_error') OR ("itervane"."tool_calls"."tool" = 'source.inspect' AND "itervane"."tool_calls"."status" = 'unknown'));