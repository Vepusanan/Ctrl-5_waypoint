CREATE TABLE "demand_history" (
	"date" date NOT NULL,
	"depot_id" text NOT NULL,
	"brand" "brand" NOT NULL,
	"orders" integer NOT NULL,
	"volume_m3" numeric(12, 3) NOT NULL,
	"chilled_volume_m3" numeric(12, 3) NOT NULL,
	CONSTRAINT "demand_history_date_depot_id_brand_pk" PRIMARY KEY("date","depot_id","brand"),
	CONSTRAINT "demand_history_nonnegative" CHECK ("demand_history"."orders" >= 0 and "demand_history"."volume_m3" >= 0 and "demand_history"."chilled_volume_m3" >= 0)
);
--> statement-breakpoint
ALTER TABLE "demand_history" ADD CONSTRAINT "demand_history_depot_id_depots_id_fk" FOREIGN KEY ("depot_id") REFERENCES "public"."depots"("id") ON DELETE no action ON UPDATE no action;