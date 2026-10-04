CREATE TABLE "loading_counts" (
	"trip_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"units" integer NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loading_counts_trip_id_order_id_pk" PRIMARY KEY("trip_id","order_id"),
	CONSTRAINT "loading_counts_units" CHECK ("loading_counts"."units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"audience" text DEFAULT 'private' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"filters" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_name_present" CHECK ("saved_views"."name" <> ''),
	CONSTRAINT "saved_views_audience" CHECK ("saved_views"."audience" in ('private', 'team'))
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "loading_counts" ADD CONSTRAINT "loading_counts_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loading_counts" ADD CONSTRAINT "loading_counts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loading_counts" ADD CONSTRAINT "loading_counts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loading_counts_order_id" ON "loading_counts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "saved_views_user_id" ON "saved_views" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolution" CHECK ((
        ("issues"."status" = 'open' and "issues"."resolved_by" is null and "issues"."resolved_at" is null)
        or ("issues"."status" = 'resolved' and "issues"."resolved_by" is not null and "issues"."resolved_at" is not null)
      ));