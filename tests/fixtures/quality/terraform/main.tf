# The region every resource is created in.
variable "region" {
  type    = string
  default = "eu-west-1"
}

# The worker fleet.
resource "aws_instance" "worker" {
  ami           = "ami-123456"
  instance_type = "t3.micro"

  lifecycle {
    create_before_destroy = true
  }
}

# Shared networking.
module "vpc" {
  source = "./modules/vpc"
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

output "worker_ip" {
  value = "x"
}
