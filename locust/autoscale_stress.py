from uuid import uuid4

from locust import HttpUser, LoadTestShape, between, task


class StressUser(HttpUser):
    wait_time = between(0.1, 0.3)

    @task
    def long_request(self):
        request_id = uuid4().hex
        context = "\n".join(
            f"Item {i}: A GPU server receives requests, schedules model inference, "
            f"and stores active token states in its KV cache."
            for i in range(30)
        )
        payload = {
            "model": "Qwen/Qwen2.5-0.5B-Instruct",
            "messages": [{
                "role": "user",
                "content": (
                    f"Request {request_id}.\n{context}\n"
                    "Explain the system in about 100 words."
                ),
            }],
            "max_tokens": 128,
        }
        with self.client.post(
            "/v1/chat/completions",
            json=payload,
            headers={"Connection": "close"},
            name="long_request",
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


class StressShape(LoadTestShape):
    def tick(self):
        elapsed = self.get_run_time()
        if elapsed < 60:
            return (1, 1)
        if elapsed < 360:
            return (8, 2)
        if elapsed < 480:
            return (1, 2)
        return None
