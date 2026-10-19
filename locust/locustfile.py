from locust import HttpUser, between, task

MODEL = "Qwen/Qwen2.5-0.5B-Instruct"


class VLLMUser(HttpUser):
    wait_time = between(0.5, 1.5)

    def send_prompt(self, prompt: str, name: str):
        payload = {
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 64,
        }
        with self.client.post(
            "/v1/chat/completions",
            json=payload,
            name=name,
            timeout=90,
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(f"HTTP {response.status_code}: {response.text[:200]}")
                return
            try:
                if not response.json()["choices"]:
                    response.failure("No completion returned")
            except (ValueError, KeyError):
                response.failure("Invalid completion response")

    @task(3)
    def short_prompt(self):
        self.send_prompt("Explain what a GPU does in two sentences.", "short_prompt")

    @task(1)
    def long_prompt(self):
        context = "A server processes incoming requests and records their latency. " * 12
        self.send_prompt(
            f"{context}\nSummarize the system in two sentences.",
            "long_prompt",
        )
