/*
 * Vietnamese edition, chapter 10-bao-cao (US-119). Converted from the BA's static page
 * `public/guide/10-bao-cao.html`.
 */
import {
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DocTable,
  InstructionList,
  Lead,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-10">
        <div>
          <ChapterEyebrow>PHẦN 10 · BÁO CÁO</ChapterEyebrow>
          <h2>Đọc tiến độ từ đúng nguồn dữ liệu</h2>
          <Lead>
            Rova cung cấp ba báo cáo chỉ đọc: <strong>Iteration Burndown</strong> theo dõi công việc
            còn lại mỗi ngày, <strong>Velocity</strong> so sánh kết quả qua các Iteration đã kết
            thúc và <strong>Team Capacity</strong> tổng hợp Capacity cùng giờ Task hiện tại.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Chọn đúng báo cáo cho câu hỏi cần trả lời.</li>
            <li>Đọc Burndown mà không nhầm Hours với Points.</li>
            <li>Phân biệt Accepted During, After và Not Accepted.</li>
            <li>Đọc Capacity, Estimate, ToDo và Actual theo Team.</li>
            <li>Nhận biết số 0, dữ liệu trống và lịch sử chưa có.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="chon-bao-cao"
        number="10.1"
        title="Chọn đúng báo cáo"
        lead="Mỗi báo cáo trả lời một câu hỏi và sử dụng nguồn dữ liệu khác nhau."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Khi cần biết</th>
              <th>Chọn Type</th>
              <th>Phạm vi thời gian</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Công việc còn lại có giảm đúng kế hoạch không?</strong>
              </td>
              <td>Iteration Burndown</td>
              <td>Một Iteration được chọn.</td>
            </tr>
            <tr>
              <td>
                <strong>Team thường hoàn tất bao nhiêu Points đúng hạn?</strong>
              </td>
              <td>Velocity</td>
              <td>5 hoặc 10 Iteration đã kết thúc gần nhất.</td>
            </tr>
            <tr>
              <td>
                <strong>Capacity và giờ Task hiện tại đang phân bổ ra sao?</strong>
              </td>
              <td>Team Capacity</td>
              <td>Một Iteration được chọn.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn Project và Team</strong>
              <p>
                Reports dùng context selector trên thanh đầu trang; không có bộ lọc Project/Team
                riêng bên trong trang.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Mở Reports</strong>
              <p>
                Chọn Type cạnh tiêu đề Reports: Iteration Burndown, Velocity hoặc Team Capacity.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Chọn thời gian</strong>
              <p>
                Burndown và Team Capacity dùng Iteration picker. Velocity dùng Window = Last 5 hoặc
                Last 10 sprints.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Đọc trạng thái dữ liệu trước</strong>
              <p>
                Nếu trang báo chưa có history hoặc chưa có dữ liệu, xử lý nguyên nhân trước khi dùng
                số liệu.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          Reports chỉ dành cho Workspace Admin và Admin của Project được gán. Editor và tài khoản
          không có quyền Project không mở được Reports. Toàn bộ báo cáo là <strong>chỉ đọc</strong>.
        </p>
      </Section>
      <Section
        id="doc-iteration-burndown"
        number="10.2"
        title="Đọc Iteration Burndown"
        lead="Burndown kết hợp giờ Task và Points của US/DE trên hai trục khác nhau."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Chuỗi dữ liệu</th>
              <th>Đơn vị</th>
              <th>Cách hiểu</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Task To Do</strong>
              </td>
              <td>Hours</td>
              <td>
                Tổng ToDo của Task vào cuối từng ngày. Giá trị nên giảm dần khi công việc được xử
                lý.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Ideal</strong>
              </td>
              <td>Hours</td>
              <td>
                Đường giảm lý tưởng từ tổng Task Estimate tại lúc Iteration bắt đầu về 0 ở ngày làm
                việc cuối.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Accepted</strong>
              </td>
              <td>Points</td>
              <td>
                Plan Estimate tích lũy của US/DE đã đạt Accepted hoặc Release tính đến từng ngày.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn Iteration</strong>
              <p>
                Dùng nút trước, danh sách Iteration và nút sau. Xác nhận đúng khoảng ngày hiển thị.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>So sánh ToDo với Ideal</strong>
              <p>
                Remaining To Do cao hơn Ideal ở ngày snapshot mới nhất được hiểu là Behind plan;
                bằng hoặc thấp hơn là On track.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Đọc Accepted Points riêng</strong>
              <p>Accepted dùng trục Points. Không lấy Points để trừ trực tiếp cho ToDo Hours.</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra tính liên tục</strong>
              <p>
                Burndown dùng snapshot cuối ngày. Ngày thiếu history phải hiển thị là không có dữ
                liệu, không tự nối hoặc dựng lại từ giá trị hôm nay.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Lịch sử Burndown được đóng băng.</strong> Sửa ToDo, Estimate hoặc phạm vi hôm nay
          không viết lại snapshot của ngày trước. Ideal cũng không đổi khi Task được thêm hoặc
          estimate lại sau lúc Iteration bắt đầu.
        </p>
        <p>
          Khi Iteration chưa có daily history, báo cáo hiển thị <strong>No burndown to show</strong>{' '}
          và không vẽ Ideal nếu chưa ghi start baseline.
        </p>
      </Section>
      <Section
        id="doc-velocity"
        number="10.3"
        title="Đọc Velocity"
        lead="Velocity tách phần việc được chấp nhận đúng hạn, trễ hạn và chưa được chấp nhận."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Nhóm</th>
              <th>Điều kiện</th>
              <th>Có tính vào Velocity?</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Accepted During Iteration</strong>
              </td>
              <td>US/DE đạt Accepted hoặc Release không muộn hơn ngày kết thúc Iteration.</td>
              <td>Có. Đây là nguồn của Trend và các giá trị trung bình.</td>
            </tr>
            <tr>
              <td>
                <strong>Accepted After Iteration</strong>
              </td>
              <td>US/DE được chấp nhận sau khi Iteration đã kết thúc.</td>
              <td>Không; chỉ dùng làm ngữ cảnh.</td>
            </tr>
            <tr>
              <td>
                <strong>Not Accepted</strong>
              </td>
              <td>US/DE hiện chưa ở Accepted hoặc Release.</td>
              <td>Không; chỉ dùng làm ngữ cảnh.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn Window</strong>
              <p>
                Last 5 sprints tập trung vào xu hướng gần; Last 10 sprints cho bức tranh ổn định hơn
                khi đủ dữ liệu.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Đọc từng cột chồng</strong>
              <p>Tổng ba phần là toàn bộ Points của US/DE hiện đang được gán cho Iteration đó.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Đọc Trend và Averages</strong>
              <p>
                Trend, Last 3, Best 3 và Worst 3 chỉ tính Accepted During. Accepted After không làm
                Velocity tốt hơn.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra số Iteration khả dụng</strong>
              <p>
                Khi có ít hơn ba Iteration, báo cáo dùng toàn bộ mẫu hiện có và phải hiển thị kích
                thước mẫu thực tế.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Velocity là phép phân loại theo dữ liệu hiện tại.</strong> Chuyển US/DE vào hoặc
          ra một Iteration cũ, đổi Plan Estimate hoặc reopen item có thể làm biểu đồ cũ thay đổi.
          Báo cáo này không dùng snapshot đóng băng như Burndown.
        </p>
        <p>
          Accepted hoặc Release thiếu acceptedDate là lỗi chất lượng dữ liệu. Không đoán item thuộc
          During hay After.
        </p>
      </Section>
      <Section
        id="doc-team-capacity-report"
        number="10.4"
        title="Đọc Team Capacity"
        lead="Báo cáo dùng cùng nguồn Capacity và giờ Task với Track → Team Status."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Chỉ số</th>
              <th>Nguồn</th>
              <th>Cách hiểu</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Capacity</strong>
              </td>
              <td>Capacity theo Member trong Iteration.</td>
              <td>Số giờ khả dụng đã được lập kế hoạch.</td>
            </tr>
            <tr>
              <td>
                <strong>Estimate</strong>
              </td>
              <td>Tổng Task Estimate.</td>
              <td>Ước lượng ban đầu của các Task trong phạm vi.</td>
            </tr>
            <tr>
              <td>
                <strong>ToDo</strong>
              </td>
              <td>Tổng Task ToDo hiện tại.</td>
              <td>Khối lượng còn lại do người dùng cập nhật.</td>
            </tr>
            <tr>
              <td>
                <strong>Actual</strong>
              </td>
              <td>Tổng Task Actual hiện tại.</td>
              <td>Giờ thực tế đã ghi nhận; có thể lớn hơn Estimate.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn Iteration</strong>
              <p>Đổi Iteration sẽ tính lại bốn tổng và toàn bộ dòng Team/Member.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Đọc theo phạm vi Team</strong>
              <p>
                Chọn một Team để xem riêng Team đó. All Teams hiển thị các Team thành từng nhóm và
                có thể mở Member bên dưới.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>So sánh bốn số giờ</strong>
              <p>
                Đọc các giá trị như dữ liệu độc lập. ToDo không bằng Estimate trừ Actual và Actual
                không bị giới hạn bởi Estimate.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra Member đặc biệt</strong>
              <p>
                Member có Capacity nhưng chưa có Task vẫn được hiển thị. Task chưa có Owner nằm dưới
                Unassigned với Capacity 0h.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Không chỉnh Capacity trong Reports.</strong> Muốn thay đổi Capacity, quay lại
          Track → Team Status. Báo cáo không tạo kho Capacity riêng.
        </p>
      </Section>
      <Section
        id="hieu-pham-vi-du-lieu"
        number="10.5"
        title="Hiểu phạm vi và thời điểm của dữ liệu"
        lead="Cùng một thao tác cập nhật có thể ảnh hưởng ba báo cáo theo cách khác nhau."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Báo cáo</th>
              <th>Kiểu dữ liệu</th>
              <th>Khi dữ liệu nguồn thay đổi</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Iteration Burndown</strong>
              </td>
              <td>Start baseline và daily snapshot đã đóng băng.</td>
              <td>
                Chỉ ngày hiện tại hoặc snapshot tương lai thay đổi; lịch sử đã chốt giữ nguyên.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Velocity</strong>
              </td>
              <td>Phân loại lại từ assignment, state, acceptedDate và Plan Estimate hiện tại.</td>
              <td>Biểu đồ của Iteration cũ có thể thay đổi.</td>
            </tr>
            <tr>
              <td>
                <strong>Team Capacity</strong>
              </td>
              <td>Projection trực tiếp từ Capacity và giờ Task hiện tại.</td>
              <td>Hiển thị lại ngay theo dữ liệu mới trong phạm vi.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          Selected Team chỉ lấy dữ liệu của Team đó. <strong>All Teams</strong> tổng hợp các Team
          trong Project và phải loại trùng theo ID ổn định. Không cộng thủ công số của All Teams với
          số từng Team.
        </p>
        <p>
          Mốc ngày dùng timezone của Workspace. Khi đối chiếu Accepted During/After hoặc snapshot
          cuối ngày, hãy kiểm tra ngày Iteration và timezone trước khi kết luận.
        </p>
      </Section>
      <Section
        id="kiem-tra-du-lieu-thieu"
        number="10.6"
        title="Phân biệt số 0 với dữ liệu chưa có"
        lead="Không dùng một trạng thái trống như bằng chứng rằng Team không làm việc."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Thông báo hoặc dấu hiệu</th>
              <th>Ý nghĩa</th>
              <th>Cần kiểm tra</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>No daily history</strong>
              </td>
              <td>Burndown chưa có snapshot cuối ngày.</td>
              <td>Snapshot job, ngày bắt đầu và lịch sử của Iteration.</td>
            </tr>
            <tr>
              <td>
                <strong>No start baseline</strong>
              </td>
              <td>Chưa ghi tổng Task Estimate tại lúc Iteration bắt đầu.</td>
              <td>Không dùng hoặc tự vẽ Ideal.</td>
            </tr>
            <tr>
              <td>
                <strong>No completed Iteration with work</strong>
              </td>
              <td>Velocity chưa có Iteration đủ điều kiện trong phạm vi.</td>
              <td>Ngày kết thúc và US/DE đang gán.</td>
            </tr>
            <tr>
              <td>
                <strong>No planned capacity and no scoped task hours</strong>
              </td>
              <td>Team Capacity không có cả Capacity lẫn Task hours.</td>
              <td>Iteration, Team, Capacity record và Task assignment.</td>
            </tr>
            <tr>
              <td>
                <strong>0h hoặc 0 Points</strong>
              </td>
              <td>Có dữ liệu hợp lệ và giá trị đo được là 0.</td>
              <td>Đọc cùng phạm vi, nguồn và thời điểm.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          Không nội suy lịch sử thiếu, không thay null bằng 0 và không dựng biểu đồ từ
          fixture/mockup để báo cáo vận hành.
        </p>
      </Section>
      <Section
        id="xu-ly-bao-cao"
        number="10.7"
        title="Xử lý tình huống thường gặp"
        lead="Kiểm tra quyền, phạm vi, thời gian và chất lượng dữ liệu theo thứ tự."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không thấy menu Reports</strong>
              <p>
                Xác nhận tài khoản là Workspace Admin hoặc Admin của Project đang chọn. Editor không
                có quyền Reports.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Không thấy Iteration cần chọn</strong>
              <p>
                Kiểm tra Project, Team và khoảng ngày. Burndown/Capacity dùng một Iteration;
                Velocity chỉ lấy Iteration đã kết thúc và có US/DE.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Burndown trống</strong>
              <p>
                Đọc thông báo daily history và start baseline. Không dùng giá trị Task hiện tại để
                tự dựng lại lịch sử.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Velocity thay đổi ở Iteration cũ</strong>
              <p>
                Kiểm tra US/DE vừa đổi Iteration, Plan Estimate, state hoặc acceptedDate. Đây là báo
                cáo tính lại theo assignment hiện tại.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Capacity khác Team Status</strong>
              <p>
                Đối chiếu cùng Project, Team và Iteration; kiểm tra Member, Task Owner và thời điểm
                tải dữ liệu.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Actual lớn hơn Estimate</strong>
              <p>
                Đây có thể là dữ liệu hợp lệ. Actual không bị cap và ToDo không được suy ra từ
                Estimate − Actual.
              </p>
            </div>
          </article>
          <article>
            <span>08</span>
            <div>
              <strong>Số All Teams lớn bất thường</strong>
              <p>
                Kiểm tra item hoặc Task trùng ID qua nhiều Team. Không cộng thêm số từng Team vào
                tổng All Teams.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <p>
          Export, cấu hình báo cáo đã lưu và khoảng ngày tùy chỉnh chưa thuộc phạm vi hướng dẫn hiện
          tại.
        </p>
      </Section>
      <CheckUnderstanding>
        <strong>Tự kiểm tra trước khi sang phần tiếp theo</strong>
        <ul>
          <li>Bạn biết Burndown dùng Hours và Points trên hai trục chưa?</li>
          <li>Bạn biết phần nào của Velocity được dùng cho Trend chưa?</li>
          <li>Bạn biết Team Capacity là báo cáo chỉ đọc từ Team Status chưa?</li>
          <li>Bạn phân biệt số 0 với trạng thái chưa có dữ liệu chưa?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
