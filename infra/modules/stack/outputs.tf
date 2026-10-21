// Re-exported by each live caller, so CI's output-sync (which reads ECS/RDS/
// networking names from the stack outputs) keeps working unchanged.
# Absent once the runtime layer's ALB is deleted; null rather than a plan error.
output "alb_dns_name" { value = try(data.terraform_remote_state.runtime.outputs.alb_dns_name, null) }
output "ecs_cluster_name" { value = module.ecs_cluster.cluster_name }
output "ecs_api_service" { value = module.api.service_name }
output "ecs_worker_service" { value = module.worker.service_name }
output "ecs_migrator_task_def" {
  value       = module.migrator.family
  description = "Migrator task definition family name — use with aws ecs run-task"
}
output "rds_endpoint" { value = module.rds.endpoint }
output "rds_master_secret_arn" { value = module.rds.master_secret_arn }
output "secret_arns" { value = module.secrets.secret_arns }

# Networking — needed for ECS run-task (migrator) and GitHub env vars.
# Sourced from the shared runtime layer (runtime-dev) so the CI output-sync stays correct.
output "private_subnet_ids" { value = data.terraform_remote_state.runtime.outputs.private_subnet_ids }
output "sg_app_id" { value = data.terraform_remote_state.runtime.outputs.sg_app_id }

# Messaging — useful for verifying queue setup

# Web (Cloudflare Pages) outputs — PAGES_PROJECT is published to GitHub env vars
# for the rova web CI (wrangler --project-name).
output "web_pages_project" { value = try(module.web[0].project_name, null) }
output "web_custom_domain" { value = try(module.web[0].custom_domain, null) }
output "web_url" { value = try("https://${module.web[0].custom_domain}", null) }

output "alarm_topic_arn" {
  value       = module.observability.alarm_topic_arn
  description = "Alarm SNS topic. Exposed so a caller can publish additional alarms to the same topic instead of creating a second one."
}
