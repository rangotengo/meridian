// Cloud migrations are bundled into the Worker; no runtime filesystem access.
import migration0 from "../../../../db/cloud-migrations/0001_init.up.sql";
import migration1 from "../../../../db/cloud-migrations/0002_features.up.sql";
import migration2 from "../../../../db/cloud-migrations/0003_sure_meroshare.up.sql";
import migration3 from "../../../../db/cloud-migrations/0004_chat_proposals.up.sql";
import migration4 from "../../../../db/cloud-migrations/0005_member_removal.up.sql";
import migration5 from "../../../../db/cloud-migrations/0006_cloudflare_access.up.sql";
import migration6 from "../../../../db/cloud-migrations/0007_storage_guards.up.sql";
import migration7 from "../../../../db/cloud-migrations/0008_api_keys.up.sql";
import migration8 from "../../../../db/cloud-migrations/0009_instance_invitations.up.sql";
import migration9 from "../../../../db/cloud-migrations/0010_mcp_oauth.up.sql";
import migration10 from "../../../../db/cloud-migrations/0011_oauth_authorization_requests.up.sql";
import migration11 from "../../../../db/cloud-migrations/0012_oauth_family_invalidation.up.sql";
import migration12 from "../../../../db/cloud-migrations/0013_portfolio_holdings.up.sql";
import migration13 from "../../../../db/cloud-migrations/0014_holding_cost_quantity.up.sql";
import migration14 from "../../../../db/cloud-migrations/0015_ssis_insight.up.sql";
import migration15 from "../../../../db/cloud-migrations/0016_ssis_config_generation.up.sql";
import migration16 from "../../../../db/cloud-migrations/0017_balance_tracking.up.sql";
import migration17 from "../../../../db/cloud-migrations/0018_mcp_ssis_access.up.sql";
import migration18 from "../../../../db/cloud-migrations/0019_ssis_dataset_coverage.up.sql";
import migration19 from "../../../../db/cloud-migrations/0020_goals.up.sql";
import migration20 from "../../../../db/cloud-migrations/0021_budgets_rollover.up.sql";
import migration21 from "../../../../db/cloud-migrations/0022_loan_interest_rate.up.sql";

export const cloudMigrations = [
  { name: "0001_init", sql: migration0 },
  { name: "0002_features", sql: migration1 },
  { name: "0003_sure_meroshare", sql: migration2 },
  { name: "0004_chat_proposals", sql: migration3 },
  { name: "0005_member_removal", sql: migration4 },
  { name: "0006_cloudflare_access", sql: migration5 },
  { name: "0007_storage_guards", sql: migration6 },
  { name: "0008_api_keys", sql: migration7 },
  { name: "0009_instance_invitations", sql: migration8 },
  { name: "0010_mcp_oauth", sql: migration9 },
  { name: "0011_oauth_authorization_requests", sql: migration10 },
  { name: "0012_oauth_family_invalidation", sql: migration11 },
  { name: "0013_portfolio_holdings", sql: migration12 },
  { name: "0014_holding_cost_quantity", sql: migration13 },
  { name: "0015_ssis_insight", sql: migration14 },
  { name: "0016_ssis_config_generation", sql: migration15 },
  { name: "0017_balance_tracking", sql: migration16 },
  { name: "0018_mcp_ssis_access", sql: migration17 },
  { name: "0019_ssis_dataset_coverage", sql: migration18 },
  { name: "0020_goals", sql: migration19 },
  { name: "0021_budgets_rollover", sql: migration20 },
  { name: "0022_loan_interest_rate", sql: migration21 }
];
