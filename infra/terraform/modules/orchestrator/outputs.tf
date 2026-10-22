output "function_name" {
  description = "Lambda function name."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "Lambda function ARN."
  value       = aws_lambda_function.this.arn
}

output "dlq_name" {
  description = "Dead-letter queue for failed ticks."
  value       = aws_sqs_queue.dlq.name
}
